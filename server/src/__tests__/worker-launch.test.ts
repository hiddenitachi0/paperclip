import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCandleWorker } from "../services/trading-candle-runner.js";
import { resolveWorkerLaunch, workerLaunchOptions } from "../services/worker-launch.js";

const SERVICES_DIR = new URL("../services/", import.meta.url);

/** The text of one balanced `new Worker( ... )` call starting at `start`. */
function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf("(", start); i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe("worker thread launch flags (DUR-5161)", () => {
  it("omits execArgv for the compiled worker so the thread inherits --import tsx and the module guard", () => {
    const launch = resolveWorkerLaunch("some-worker", import.meta.url, true);
    expect(launch.url.pathname.endsWith("/some-worker.js")).toBe(true);
    expect(launch.execArgv).toBeUndefined();
    // Nothing is handed to `new Worker`, not even an empty array.
    expect(workerLaunchOptions(launch)).toEqual({});
    expect("execArgv" in workerLaunchOptions(launch)).toBe(false);
  });

  it("loads the .ts worker through tsx when running from source", () => {
    const launch = resolveWorkerLaunch("trading-candle-worker", new URL("../services/x.ts", import.meta.url), false);
    expect(launch.url.pathname.endsWith("/trading-candle-worker.ts")).toBe(true);
    expect(workerLaunchOptions(launch).execArgv?.[0]).toBe("--import");
  });

  it("the candle runner uses the shared helper", () => {
    expect(resolveCandleWorker(true).execArgv).toBeUndefined();
  });

  it("every new Worker(...) in server/src/services takes its flags from workerLaunchOptions, never an explicit execArgv", () => {
    const files = readdirSync(SERVICES_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    let workers = 0;
    for (const file of files) {
      if (file === "worker-launch.ts") continue;
      const source = readFileSync(new URL(file, SERVICES_DIR), "utf8");
      if (!source.includes("worker_threads")) continue;
      for (const match of source.matchAll(/new Worker\(/g)) {
        workers++;
        const call = callText(source, match.index!);
        // Plain Worker options with an `execArgv` key replace the inherited flags.
        if (/\bexecArgv\b/.test(call) || !call.includes("workerLaunchOptions(")) {
          offenders.push(`${file}: ${call.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    // The three runners: candle, backtest/template (one Worker call), contract extraction.
    expect(workers).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
