import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCandleWorker } from "../services/trading-candle-runner.js";

describe("candle worker launch (DUR-5129)", () => {
  it("does not pass execArgv for the compiled worker, so the thread inherits the parent's flags", () => {
    const launch = resolveCandleWorker(true);
    expect(launch.url.pathname.endsWith("/trading-candle-worker.js")).toBe(true);
    // An explicit [] would replace the inherited tsx loader and module guard.
    expect(launch.execArgv).toBeUndefined();
  });

  it("loads the .ts worker through tsx when running from source", () => {
    const launch = resolveCandleWorker(false);
    expect(launch.url.pathname.endsWith("/trading-candle-worker.ts")).toBe(true);
    expect(launch.execArgv?.[0]).toBe("--import");
  });

  it("a real worker thread keeps the parent's --require guard and --import tsx loader", () => {
    const dir = new URL("./fixtures/candle-worker-inherit/", import.meta.url);
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const out = execFileSync(
      process.execPath,
      ["--require", new URL("guard-stub.cjs", dir).pathname, "--import", tsx, new URL("harness.ts", dir).pathname],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ dep: "dep-loaded", guarded: true });
  }, 70_000);
});
