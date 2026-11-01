// Stand-in for the compiled candle worker: it only proves that the worker
// thread can import `@paperclipai/db` (a .ts package that imports ./client.js).
import { parentPort } from "node:worker_threads";

try {
  const db = await import("@paperclipai/db");
  parentPort.postMessage({ ok: typeof db.createDb === "function" });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
