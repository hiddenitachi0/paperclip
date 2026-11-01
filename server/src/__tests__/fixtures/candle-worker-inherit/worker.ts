import { parentPort } from "node:worker_threads";
// ./dep.js only resolves to dep.ts when the tsx loader is active in this thread.
import { dep } from "./dep.js";

parentPort!.postMessage({ type: "result", result: { dep, guarded: (globalThis as Record<symbol, unknown>)[Symbol.for("test.moduleGuard")] === true } });
