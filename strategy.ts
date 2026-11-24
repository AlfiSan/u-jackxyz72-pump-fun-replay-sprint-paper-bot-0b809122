// Early-burst rider for pump.fun bonding curves.
//
// Most new coins on pump.fun spike within their first minutes and then
// bleed out. Chasing every launch loses money; holding through the fade
// loses more. This bot only steps in when a young coin has already shown
// a real breakout — up from its birth price, still hugging its recent
// high, with buyers doing most of the recent volume — and then it leaves
// at the first of four exits: a take-profit, a trailing stop once the
// trade is working, a stop-loss, or a hard time limit. One buy per coin,
// one fixed stake, no adding to losers, no second chances.
//
// Everything is a pure function of the harness state and the batch: no
// randomness, no clock, no network, no environment reads. Two runs over
// the same window therefore emit identical orders, which the replay
// harness requires (it executes each entry twice and the two action logs
// must match byte for byte).

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------ parameters

export interface Params {
  stakeSol: number;
  minRealSol: number;
  youngSlots: number;
  maxTrades: number;
  minRise: number;
  nearHigh: number;
  pressureTrades: number;
  minBuys: number;
  minBuyShare: number;
  highTrades: number;
  takeProfit: number;
  trailArm: number;
  trailDrop: number;
  stopLoss: number;
  maxHoldSlots: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  maxOpen: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.15,
  minRealSol: 5,
  youngSlots: 4000,
  maxTrades: 150,
  minRise: 0.15,
  nearHigh: 0.97,
  pressureTrades: 10,
  minBuys: 7,
  minBuyShare: 0.75,
  highTrades: 15,
  takeProfit: 0.2,
  trailArm: 0.08,
  trailDrop: 0.04,
  stopLoss: 0.12,
  maxHoldSlots: 3000,
  buySlippageBps: 800,
  sellSlippageBps: 10_000,
  maxOpen: 5,
};

// ------------------------------------------------------------ per-coin books

/** One token's price in SOL, from its virtual curve reserves. */
function quotePrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens <= 0n || virtualQuote <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

interface CoinBook {
  mint: string;
  bornSlot: number;
  bornPrice: number;
  trades: number;
  /** Latest trades, oldest first: who bought and how much SOL moved. */
  tape: { buy: boolean; sol: number }[];
  /** Latest prices, oldest first, for the recent-high check. */
  prices: number[];
  settled: boolean; // bought already, or ruled out for good
}

interface Holding {
  mint: string;
  cost: number; // price actually paid per token (from the fill)
  costSlot: number;
  peak: number;
  selling: boolean;
}

// ------------------------------------------------------------ the strategy

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<string, CoinBook>();
  const held = new Map<string, Holding>();
  const stake = BigInt(Math.round(p.stakeSol * 1e9));
  const minReal = BigInt(p.minRealSol) * LAMPORTS_PER_SOL;

  function bookFor(mint: string, slot: number, price: number): CoinBook {
    let b = books.get(mint);
    if (b === undefined) {
      b = { mint, bornSlot: slot, bornPrice: price, trades: 0, tape: [], prices: [], settled: false };
      books.set(mint, b);
    }
    return b;
  }

  function recordTrade(b: CoinBook, price: number, isBuy: boolean, solLamports: bigint): void {
    b.trades += 1;
    b.tape.push({ buy: isBuy, sol: Number(solLamports) / 1e9 });
    if (b.tape.length > p.pressureTrades) b.tape.shift();
    b.prices.push(price);
    if (b.prices.length > p.highTrades) b.prices.shift();
  }

  function recentHigh(b: CoinBook): number {
    let high = 0;
    for (const price of b.prices) if (price > high) high = price;
    return high;
  }

  /** Every entry condition, checked in cheap-first order. */
  function breakoutReady(state: BotState, b: CoinBook): boolean {
    if (b.settled) return false;
    if (state.slot - b.bornSlot > p.youngSlots) return false;
    if (b.trades > p.maxTrades || b.trades < p.minBuys) return false;
    const curve = state.curves.get(b.mint);
    if (curve === undefined || curve.complete) return false;
    if (curve.real_quote_reserves < minReal) return false;
    const price = quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0) return false;
    // Up over birth and still near the top: a live breakout, not a faded pump.
    if (price < b.bornPrice * (1 + p.minRise)) return false;
    if (price < recentHigh(b) * p.nearHigh) return false;
    // Buyers must be doing the recent volume, not just the recent count.
    let buys = 0;
    let buySol = 0;
    let allSol = 0;
    for (const t of b.tape) {
      allSol += t.sol;
      if (t.buy) {
        buys += 1;
        buySol += t.sol;
      }
    }
    if (buys < p.minBuys) return false;
    if (allSol <= 0 || buySol / allSol < p.minBuyShare) return false;
    return true;
  }

  /** True when any exit rule fires; also maintains the running peak. */
  function shouldExit(state: BotState, h: Holding): boolean {
    const curve = state.curves.get(h.mint);
    if (curve === undefined || curve.complete) return false;
    const price = quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0) return false;
    if (price > h.peak) h.peak = price;
    if (price >= h.cost * (1 + p.takeProfit)) return true;
    if (price <= h.cost * (1 - p.stopLoss)) return true;
    if (h.peak >= h.cost * (1 + p.trailArm) && price <= h.peak * (1 - p.trailDrop)) return true;
    if (state.slot - h.costSlot >= p.maxHoldSlots) return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // 0. Re-base costs on fills. A buy decided in one batch fills two
      // slots later at the fill price, not the decision price, so the
      // profit, stop and trailing levels must measure from what was paid:
      // quote spent per token received.
      for (const f of batch.fills) {
        if (f.side !== 'buy' || f.status !== 'filled') continue;
        const tokens = BigInt(f.token_amount);
        const spent = BigInt(f.quote_lamports);
        if (tokens <= 0n || spent <= 0n) continue;
        const h = held.get(f.mint);
        if (h === undefined) continue;
        const paid = Number(spent) / Number(tokens);
        h.cost = paid;
        h.peak = paid;
        h.costSlot = f.slot;
      }

      // 1. Fold the batch's events into the per-coin books.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const price = quotePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          bookFor(e.mint, e.slot, price > 0 ? price : 0);
        } else if (e.event === 'TradeEvent') {
          const price = quotePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          recordTrade(bookFor(e.mint, e.slot, price), price, e.is_buy, BigInt(e.sol_amount));
        } else {
          // CompleteEvent: the curve is done; drop the book.
          books.delete(e.mint);
        }
      }

      // Drop holdings whose position is gone, and clear sell flags whose
      // pending order has resolved without a fill.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) held.delete(mint);
      }
      for (const h of held.values()) {
        if (!h.selling) continue;
        const stillOut = [...state.pending.values()].some(
          (o) => o.order.side === 'sell' && o.order.mint === h.mint,
        );
        if (!stillOut) h.selling = false;
      }

      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let room = Math.min(state.hello.caps.max_open_positions, p.maxOpen) - state.committedPositionCount();

      // 2. Exits first: sell every held coin whose exit rule fired.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        let h = held.get(mint);
        if (h === undefined) {
          // Holding without a book (book dropped mid-trade): rebuild from
          // the current price so the time stop still applies and the
          // trailing stop cannot fire on stale data.
          const curve = state.curves.get(mint);
          const price = curve === undefined ? 0 : quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          h = { mint, cost: price, costSlot: state.slot, peak: price, selling: false };
          held.set(mint, h);
        }
        if (h.selling) continue;
        if (!shouldExit(state, h)) continue;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: p.sellSlippageBps,
        };
        orders.push(sell);
        h.selling = true;
      }

      // 3. Entries: walk the batch's events in order, buy fresh breakouts.
      for (const e of batch.events) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (room <= 0) break;
        const b = books.get(e.mint);
        if (b === undefined || !breakoutReady(state, b)) continue;
        const cap = state.maxBuyLamports(e.mint);
        if (cap <= 0n) {
          b.settled = true;
          continue;
        }
        const amount = cap < stake ? cap : stake;
        if (free < amount + tx) {
          // Out of cash for now; leave the coin unsettled so a later
          // batch can still take it once sells free cash up.
          continue;
        }
        const buy: BuyInput = {
          side: 'buy',
          mint: e.mint,
          quote_lamports: amount,
          max_slippage_bps: p.buySlippageBps,
        };
        orders.push(buy);
        b.settled = true;
        const curve = state.curves.get(e.mint);
        const price = curve === undefined ? 0 : quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        held.set(e.mint, { mint: e.mint, cost: price, costSlot: state.slot, peak: price, selling: false });
        free -= amount + tx;
        room -= 1;
      }

      return orders;
    },
  };
}
