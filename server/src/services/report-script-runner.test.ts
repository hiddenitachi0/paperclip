import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeScriptFingerprint, reportScriptRunner, type ScriptFilesInput } from "./report-script-runner.js";
import { compareFixtureOutput } from "./report-scripts.js";

function script(code: string): ScriptFilesInput {
  const files = { "main.py": code };
  return { files, entrypoint: "main.py", lockfile: null, sha256: computeScriptFingerprint({ files, entrypoint: "main.py", lockfile: null }) };
}

const SUM_SCRIPT = `import json, sys
data = json.load(sys.stdin)
print(json.dumps({"total": sum(r["amount"] for r in data["rows"]), "count": len(data["rows"])}))
`;

describe("reportScriptRunner", () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "report-runner-test-"));
  });
  afterEach(async () => {
    // runtimes are chmod'd read-only after build
    await fsp.chmod(root, 0o755).catch(() => {});
    for (const e of fs.readdirSync(root)) {
      const p = path.join(root, e);
      if (fs.statSync(p).isDirectory()) await fsp.chmod(p, 0o755).catch(() => {});
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("fixture: sums a JSON input and returns the same JSON output every time", async () => {
    const runner = reportScriptRunner({ runtimeRoot: root });
    const s = script(SUM_SCRIPT);
    const input = { rows: [{ amount: 100.5 }, { amount: 49.5 }] };
    const a = await runner.run(s, input);
    const b = await runner.run(s, input);
    expect(a.status).toBe("succeeded");
    if (a.status !== "succeeded" || b.status !== "succeeded") return;
    expect(a.output).toEqual({ total: 150, count: 2 });
    expect(b.outputSha256).toBe(a.outputSha256);
    expect(b.runtimeFingerprint).toBe(a.runtimeFingerprint);
  });

  it("reports a failing script as failed with its stderr, never throws", async () => {
    const runner = reportScriptRunner({ runtimeRoot: root });
    const out = await runner.run(script("raise SystemExit('boom')"), {});
    expect(out.status).toBe("failed");
  });

  it("kills a script that runs past the time limit", async () => {
    const runner = reportScriptRunner({ runtimeRoot: root, timeoutMs: 500 });
    const out = await runner.run(script("import time\ntime.sleep(30)"), {});
    expect(out.status).toBe("timeout");
  });

  it("fails a script whose output is not JSON", async () => {
    const runner = reportScriptRunner({ runtimeRoot: root });
    const out = await runner.run(script("print('not json')"), {});
    expect(out.status).toBe("failed");
  });

  it("refuses to run when the built runtime was tampered with", async () => {
    const runner = reportScriptRunner({ runtimeRoot: root });
    const s = script(SUM_SCRIPT);
    await runner.run(s, { rows: [] });
    const dir = path.join(root, s.sha256);
    await fsp.chmod(dir, 0o755);
    await fsp.chmod(path.join(dir, "main.py"), 0o644);
    await fsp.writeFile(path.join(dir, "main.py"), "print('{\"total\": 999999}')");
    // A tampered directory is rebuilt from the pinned source, never trusted.
    const out = await runner.run(s, { rows: [{ amount: 1 }] });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") expect(out.output).toEqual({ total: 1, count: 1 });
  });

  it("fingerprint changes when any file changes", () => {
    expect(script("print(1)").sha256).not.toBe(script("print(2)").sha256);
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
