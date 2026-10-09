import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeScriptFingerprint, reportScriptRunner, type ScriptFilesInput } from "./report-script-runner.js";
import { compareFixtureOutput } from "./report-scripts.js";

function script(code: string, extra: Record<string, string> = {}): ScriptFilesInput {
  return { files: { "main.py": code, ...extra }, entrypoint: "main.py" };
}

const SUM_SCRIPT = `import json, sys
data = json.load(sys.stdin)
print(json.dumps({"total": sum(r["amount"] for r in data["rows"]), "count": len(data["rows"])}))
`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("reportScriptRunner", () => {
  let workRoot: string;
  let markerDir: string;
  beforeEach(async () => {
    workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "report-runner-test-"));
    markerDir = await fsp.mkdtemp(path.join(os.tmpdir(), "report-runner-marker-"));
  });
  afterEach(async () => {
    await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(markerDir, { recursive: true, force: true }).catch(() => {});
  });

  it("sums a JSON input and returns the same JSON output every time, leaving no run directory behind", async () => {
    const runner = reportScriptRunner({ workRoot });
    const s = script(SUM_SCRIPT);
    const input = { rows: [{ amount: 100.5 }, { amount: 49.5 }] };
    const a = await runner.run(s, input);
    const b = await runner.run(s, input);
    expect(a.status).toBe("succeeded");
    if (a.status !== "succeeded" || b.status !== "succeeded") return;
    expect(a.output).toEqual({ total: 150, count: 2 });
    expect(b.outputSha256).toBe(a.outputSha256);
    expect(a.runtimeFingerprint).toBe(computeScriptFingerprint(s));
    expect(fs.readdirSync(workRoot)).toEqual([]);
  });

  it("can import its own helper modules", async () => {
    const runner = reportScriptRunner({ workRoot });
    const out = await runner.run(
      script("import json, helpers\nprint(json.dumps({'v': helpers.double(21)}))", { "helpers.py": "def double(x):\n    return x * 2\n" }),
      {},
    );
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") expect(out.output).toEqual({ v: 42 });
  });

  it("runs with an empty environment and without site-packages (standard library only)", async () => {
    process.env.PAPERCLIP_TEST_SECRET = "should-not-leak";
    try {
      const runner = reportScriptRunner({ workRoot });
      const out = await runner.run(
        script("import json, os, sys\nprint(json.dumps({'env': sorted(os.environ), 'no_site': sys.flags.no_site, 'ignore_env': sys.flags.ignore_environment, 'paths': [p for p in sys.path if 'site-packages' in p or 'dist-packages' in p]}))"),
        {},
      );
      expect(out.status).toBe("succeeded");
      if (out.status !== "succeeded") return;
      const o = out.output as { env: string[]; no_site: number; ignore_env: number; paths: string[] };
      expect(o.env).not.toContain("PAPERCLIP_TEST_SECRET");
      expect(o.env).not.toContain("DATABASE_URL");
      expect(o.env.filter((k) => !["PATH", "HOME", "TMPDIR", "LANG", "PWD", "SHLVL", "_"].includes(k))).toEqual([]);
      expect(o.no_site).toBe(1);
      expect(o.ignore_env).toBe(1);
      expect(o.paths).toEqual([]);
    } finally {
      delete process.env.PAPERCLIP_TEST_SECRET;
    }
  });

  it("cannot start other processes or threads (so it cannot fork + setsid a child that outlives the run)", async () => {
    const marker = path.join(markerDir, "escaped");
    const code = `import json, os, subprocess, threading, time
res = {}
try:
    pid = os.fork()
    if pid == 0:
        os.setsid()
        time.sleep(1.5)
        open(${JSON.stringify(marker)}, "w").write("escaped")
        os._exit(0)
    res["fork"] = "ok"
except OSError as e:
    res["fork"] = "refused"
try:
    subprocess.run(["true"])
    res["subprocess"] = "ok"
except OSError:
    res["subprocess"] = "refused"
try:
    t = threading.Thread(target=lambda: None); t.start(); t.join()
    res["thread"] = "ok"
except RuntimeError:
    res["thread"] = "refused"
print(json.dumps(res))
`;
    const runner = reportScriptRunner({ workRoot });
    const out = await runner.run(script(code), {});
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") expect(out.output).toEqual({ fork: "refused", subprocess: "refused", thread: "refused" });
    await new Promise((r) => setTimeout(r, 2000));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("the same process limits hold without the network namespace (as in the production container)", async () => {
    const runner = reportScriptRunner({ workRoot, disableNetworkNamespace: true });
    const out = await runner.run(
      script("import json, os\ntry:\n    os.fork(); r = 'ok'\nexcept OSError:\n    r = 'refused'\nprint(json.dumps({'fork': r}))"),
      {},
    );
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") expect(out.output).toEqual({ fork: "refused" });
  });

  it("kills a script that runs past the wall-clock limit, and nothing of it survives", async () => {
    const pidFile = path.join(markerDir, "pid");
    const runner = reportScriptRunner({ workRoot, timeoutMs: 700 });
    const out = await runner.run(script(`import os, time\nopen(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))\ntime.sleep(30)`), {});
    expect(out.status).toBe("timeout");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(pidAlive(pid)).toBe(false);
  });

  it("stops a script that uses more CPU time than allowed", async () => {
    const runner = reportScriptRunner({ workRoot, cpuSeconds: 1, timeoutMs: 20_000 });
    const out = await runner.run(script("while True:\n    pass"), {});
    expect(out.status).toBe("timeout");
    if (out.status === "timeout") expect(out.error).toMatch(/CPU/);
    expect(out.durationMs).toBeLessThan(15_000);
  });

  it("caps memory", async () => {
    const runner = reportScriptRunner({ workRoot, memoryLimitMb: 128 });
    const out = await runner.run(script("x = bytearray(512 * 1024 * 1024)\nprint('{}')"), {});
    expect(out.status).toBe("failed");
    expect(out.stderrTail).toMatch(/MemoryError/);
  });

  it("caps the size of any single file it writes", async () => {
    const runner = reportScriptRunner({ workRoot, maxFileMb: 1 });
    const out = await runner.run(
      script("import os\nwith open(os.path.join(os.environ['TMPDIR'], 'big'), 'wb') as f:\n    f.write(b'x' * (3 * 1024 * 1024))\nprint('{}')"),
      {},
    );
    expect(out.status).toBe("failed");
  });

  it("caps the total size of its scratch folder", async () => {
    const runner = reportScriptRunner({ workRoot, maxFileMb: 1, maxScratchMb: 2, timeoutMs: 20_000 });
    const code = `import os, time
d = os.environ['TMPDIR']
for i in range(8):
    with open(os.path.join(d, f'f{i}'), 'wb') as f:
        f.write(b'x' * (900 * 1024))
time.sleep(10)
print('{}')
`;
    const out = await runner.run(script(code), {});
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.error).toMatch(/scratch folder/);
    expect(out.durationMs).toBeLessThan(8_000);
  });

  it("every run starts from a fresh copy of the code: a run that edits its own files does not affect the next", async () => {
    const runner = reportScriptRunner({ workRoot });
    const code = "import json\ntry:\n    open(__file__, 'a').write('\\nprint(json.dumps({\"tampered\": 1}))\\nraise SystemExit(0)')\nexcept OSError:\n    pass\nprint(json.dumps({'ok': 1}))\n";
    const first = await runner.run(script(code), {});
    const second = await runner.run(script(code), {});
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (second.status === "succeeded") expect(second.output).toEqual({ ok: 1 });
    expect(fs.readdirSync(workRoot)).toEqual([]);
  });

  it("reports a failing script as failed with its stderr, never throws", async () => {
    const runner = reportScriptRunner({ workRoot });
    const out = await runner.run(script("raise SystemExit('boom')"), {});
    expect(out.status).toBe("failed");
    expect(out.stderrTail).toMatch(/boom/);
  });

  it("fails a script whose output is not JSON", async () => {
    const runner = reportScriptRunner({ workRoot });
    const out = await runner.run(script("print('not json')"), {});
    expect(out.status).toBe("failed");
  });

  it("fingerprint changes when any file or the entrypoint changes", () => {
    expect(computeScriptFingerprint(script("print(1)"))).not.toBe(computeScriptFingerprint(script("print(2)")));
    expect(computeScriptFingerprint({ files: { "a.py": "", "b.py": "" }, entrypoint: "a.py" })).not.toBe(
      computeScriptFingerprint({ files: { "a.py": "", "b.py": "" }, entrypoint: "b.py" }),
    );
  });
});

describe("compareFixtureOutput", () => {
  it("passes within tolerance and flags a number that differs", () => {
    expect(compareFixtureOutput({ a: 1, b: [2] }, { a: 1.004, b: [2] }, 0.01)).toEqual([]);
    expect(compareFixtureOutput({ a: 1 }, { a: 2 }, 0)).toHaveLength(1);
  });
  it("flags a missing key", () => {
    expect(compareFixtureOutput({ a: 1 }, {}, 0).length).toBeGreaterThan(0);
  });
});
