// Pump.fun Replay Sprint — paper bot entry point.
//
// The grader runs this file as `node /bot/main.ts` with this directory
// mounted at /bot, feeding it the replay over stdin: one hello line with
// the run's capital, caps, fees and seed, then one batch per slot, then
// a done line. Node 22 runs TypeScript as it is, so there is no build
// step and no dependency to install.
//
// This file does no trading itself. It builds one strategy from
// strategy.ts and hands each batch to it, sending back whatever orders
// come out. All of the trading logic lives in that one file; this one
// is only the wire between the harness and the strategy, so the bot's
// behaviour is identical every time the same replay is fed in.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
