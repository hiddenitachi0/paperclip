import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCheckArgs,
  buildRenderArgs,
  buildSnapshotArgs,
  childEnv,
  parseCheckReport,
  parseProbe,
  parseProgressLine,
  runProcess,
  tail,
} from "../src/hyperframes.mjs";
import { readToken } from "../src/config.mjs";

describe("childEnv", () => {
  it("is an allowlist: the worker's token and other variables never reach a child", () => {
    process.env.RENDER_WORKER_TOKEN = "t".repeat(40);
    process.env.SOME_SECRET = "nope";
    try {
      const env = childEnv({ jobHome: "/work/jobs/1/home", browserPath: "/usr/local/bin/chrome-headless-shell" });
      assert.equal(env.RENDER_WORKER_TOKEN, undefined);
      assert.equal(env.SOME_SECRET, undefined);
      assert.equal(env.HOME, "/work/jobs/1/home");
      assert.equal(env.HYPERFRAMES_NO_TELEMETRY, "1");
      assert.equal(env.HYPERFRAMES_BROWSER_PATH, "/usr/local/bin/chrome-headless-shell");
      assert.equal(env.PRODUCER_BROWSER_GPU_MODE, "software");
      assert.equal(env.TZ, "UTC");
    } finally {
      delete process.env.RENDER_WORKER_TOKEN;
      delete process.env.SOME_SECRET;
    }
  });
});

describe("readToken", () => {
  it("removes the token from the environment after reading it", () => {
    const env = { RENDER_WORKER_TOKEN: "a".repeat(48) };
    assert.equal(readToken(env), "a".repeat(48));
    assert.equal(env.RENDER_WORKER_TOKEN, undefined);
  });

  it("refuses a short token", () => {
    assert.throws(() => readToken({ RENDER_WORKER_TOKEN: "short" }), /at least 32/);
    assert.throws(() => readToken({}), /at least 32/);
  });
});

describe("argument builders", () => {
  it("check asks for JSON", () => {
    assert.deepEqual(buildCheckArgs("/p"), ["check", "/p", "--json"]);
  });

  it("snapshot never asks a vision service and clamps the frame count", () => {
    const args = buildSnapshotArgs("/p", "/o", 500);
    assert.deepEqual(args.slice(0, 6), ["snapshot", "/p", "-o", "/o", "--frames", "24"]);
    assert.ok(args.includes("--describe") && args[args.indexOf("--describe") + 1] === "false");
  });

  it("render is local, mp4, strict, software-rendered and clamped", () => {
    const args = buildRenderArgs({ projectDir: "/p", entry: "index.html", outFile: "/o/video.mp4", fps: 500, quality: "ultra", workers: 9 });
    assert.equal(args[0], "render");
    assert.ok(!args.includes("cloud"));
    assert.equal(args[args.indexOf("--fps") + 1], "60");
    assert.equal(args[args.indexOf("--quality") + 1], "standard");
    assert.equal(args[args.indexOf("--workers") + 1], "4");
    assert.equal(args[args.indexOf("--format") + 1], "mp4");
    assert.ok(args.includes("--strict"));
    assert.ok(args.includes("--no-browser-gpu"));
    assert.ok(!args.includes("--quiet"), "--quiet hides the reason a strict render failed");
    assert.ok(!args.includes("-c"));
  });

  it("render names a non-default entry file", () => {
    const args = buildRenderArgs({ projectDir: "/p", entry: "scenes/main.html", outFile: "/o/v.mp4", fps: 30, quality: "high", workers: 1 });
    assert.equal(args[args.indexOf("-c") + 1], "scenes/main.html");
  });
});

describe("parsers", () => {
  it("parseProbe reads length and size", () => {
    const out = JSON.stringify({ format: { duration: "20.033" }, streams: [{ codec_type: "audio" }, { codec_type: "video", width: 1920, height: 1080 }] });
    assert.deepEqual(parseProbe(out), { durationSeconds: 20.033, width: 1920, height: 1080, hasVideo: true });
    assert.equal(parseProbe("not json"), null);
  });

  it("parseCheckReport skips progress text before the JSON", () => {
    assert.deepEqual(parseCheckReport('Checking...\n{"ok":true,"errorCount":0}'), { ok: true, errorCount: 0 });
    assert.equal(parseCheckReport("no json here"), null);
  });

  it("tail keeps the last lines only", () => {
    assert.equal(tail("a\nb\n\nc\nd", 2), "c\nd");
  });

  it("tail drops colour codes, progress bars and trace lines", () => {
    const out = [
      "\u001b[31m  ✗ missing_timeline_registry: Missing registration.\u001b[0m",
      '@hf-progress {"code":"capture","pct":55}',
      "  ███░░  55%  Streaming frame 65/120",
      '[INFO] [Render:trace] {"phase":"assemble"}',
      "  Aborting render due to lint issues (--strict mode).",
    ].join("\n");
    assert.equal(tail(out), "  ✗ missing_timeline_registry: Missing registration.\n  Aborting render due to lint issues (--strict mode).");
  });

  it("parseProgressLine reads Hyperframes progress lines only", () => {
    assert.deepEqual(parseProgressLine('@hf-progress {"code":"encode","done":120,"total":120,"pct":90}'), { pct: 90, stage: "encode" });
    assert.equal(parseProgressLine("@hf-progress not-json"), null);
    assert.equal(parseProgressLine("Rendering 50%"), null);
  });
});

describe("runProcess", () => {
  it("reports the exit code and output", async () => {
    const res = await runProcess("sh", ["-c", "echo out; echo err >&2; exit 3"], { cwd: "/", env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
    assert.equal(res.code, 3);
    assert.equal(res.stdout.trim(), "out");
    assert.equal(res.stderr.trim(), "err");
    assert.equal(res.timedOut, false);
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    // A background grandchild must die too, or the pipe would stay open.
    const res = await runProcess("sh", ["-c", "sleep 30 & sleep 30"], { cwd: "/", env: { PATH: process.env.PATH }, timeoutMs: 300 });
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - started < 10_000);
  });

  it("reports progress lines as they arrive", async () => {
    const seen = [];
    await runProcess("sh", ["-c", `echo '@hf-progress {"code":"capture","pct":10}'; echo noise; echo '@hf-progress {"code":"encode","pct":95}'`], {
      cwd: "/",
      env: { PATH: process.env.PATH },
      timeoutMs: 10_000,
      onProgress: (p) => seen.push(p),
    });
    assert.deepEqual(seen, [{ pct: 10, stage: "capture" }, { pct: 95, stage: "encode" }]);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const pending = runProcess("sh", ["-c", "sleep 30"], { cwd: "/", env: { PATH: process.env.PATH }, timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const res = await pending;
    assert.equal(res.cancelled, true);
  });
});
