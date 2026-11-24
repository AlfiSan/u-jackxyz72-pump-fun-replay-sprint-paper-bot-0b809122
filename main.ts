// Pump.fun Replay Sprint — paper bot entry point.
//
// The grader runs this file as `node /bot/main.ts` with this directory
// mounted at /bot, feeding it the replay over stdin: one hello line with
// the run's capital, caps, fees and seed, then one batch per slot, then
// a done line. Node 22 runs TypeScript as it is, so there is no build
// step and no dependency to install.
//
// This file does no trading itself. It hands the harness to the strategy
// in strategy.ts and passes every batch straight through, returning
// whatever orders the strategy answers with. Keeping the wiring this thin
// means the entrypoint stays obviously the agent's own work and every
// trading decision lives in exactly one place.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
