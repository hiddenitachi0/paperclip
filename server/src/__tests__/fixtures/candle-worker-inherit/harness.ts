import { spawnCandleWorker, resolveCandleWorker } from "../../../services/trading-candle-runner.js";

// Same shape as the compiled branch: a bare URL, no execArgv.
const compiled = resolveCandleWorker(true);
const launch = { url: new URL("./worker.ts", import.meta.url), ...(compiled.execArgv ? { execArgv: compiled.execArgv } : {}) };
const result = await spawnCandleWorker({ databaseUrl: "unused", budgetMs: 1, runArchives: false }, () => {}, 20_000, launch);
console.log(JSON.stringify(result));
