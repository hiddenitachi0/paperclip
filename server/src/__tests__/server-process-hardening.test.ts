/**
 * DUR-3994 Stage 1: an agent (same Linux user as the server) must not be able
 * to stop, freeze or look inside the server process.
 *
 *  - `kill -USR1 <server>`: with --disable-sigusr1 Node keeps SIGUSR1 blocked
 *    in every thread and installs no handler, so the signal is never
 *    delivered -- no debugger, and the server keeps running.
 *  - /proc/<server>/fd: the server runs from a copy of Node the agents may
 *    start but not read. Linux marks such a process "not dumpable", which
 *    makes /proc/<pid>/{fd,environ,mem} root-only. Without it an agent could
 *    reopen the server's internal pipes and drain them; draining libuv's
 *    signal-lock pipe froze the whole server in the acceptance run.
 *
 * The acceptance harness (scripts/agent-isolation-acceptance.sh) checks the
 * same things in the built image; these tests pin the mechanism.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SIGUSR1_BIT = 1n << 9n; // signal 10

const isLinux = process.platform === "linux";
const hasDisableSigusr1 = process.allowedNodeEnvironmentFlags.has("--disable-sigusr1");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A tiny stand-in server: answers "pong" to every "ping" line on stdin.
const PING_SERVER = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { if (d.includes("ping")) process.stdout.write("pong\\n"); });
process.stdout.write("ready\\n");
`;

function startPingServer(execPath: string, flags: string[]): Promise<ChildProcess> {
  const child = spawn(execPath, [...flags, "-e", PING_SERVER], { stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", () => resolve(child));
  });
}

function ping(child: ChildProcess, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.stdout!.once("data", (d: Buffer) => {
      clearTimeout(timer);
      resolve(d.toString().includes("pong"));
    });
    child.stdin!.write("ping\n");
  });
}

function statusMask(file: string, field: string): bigint {
  const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${field}:`));
  return BigInt(`0x${line!.split(":")[1]!.trim()}`);
}

describe("the Docker image starts the server hardened", () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const production = dockerfile.slice(dockerfile.indexOf("FROM base AS production"));

  it("installs a root-owned, execute-only copy of Node for the server", () => {
    expect(production).toMatch(
      /RUN install -o root -g root -m 0711 \/usr\/local\/bin\/node \/usr\/local\/lib\/paperclip\/node\n/,
    );
  });

  it("starts the server from that copy, with --disable-sigusr1", () => {
    const cmd = production.split("\n").find((line) => line.startsWith("CMD "));
    expect(JSON.parse(cmd!.slice(4)).slice(0, 2)).toEqual(["/usr/local/lib/paperclip/node", "--disable-sigusr1"]);
  });

  // Node as PID 1 does not reap orphaned grandchildren: every CLI run's tsx
  // loader leaves an `esbuild` helper behind, which stayed a zombie until the
  // container hit its process limit (~16 hours, "Cannot fork"). `init: true`
  // makes Docker's init PID 1 (it reaps), with the server as its child. Set in
  // the base compose file so every overlay (prod, secrets, CI) inherits it.
  it("runs the server container under Docker's init so orphans are reaped", () => {
    const compose = fs.readFileSync(path.join(REPO_ROOT, "docker/docker-compose.yml"), "utf8");
    // One block per top-level key or service (lines indented by 0 or 2 spaces).
    const serverBlock = compose.split(/\n(?=\S|  \S)/).find((block) => block.startsWith("  server:"));
    expect(serverBlock, "docker/docker-compose.yml has a `server` service").toBeDefined();
    expect(serverBlock).toMatch(/^    init: true$/m);
  });
});

describe.skipIf(!isLinux || !hasDisableSigusr1)("kill -USR1 with --disable-sigusr1", () => {
  it("SIGUSR1 stays blocked in every thread with no handler, and the process keeps answering", async () => {
    const child = await startPingServer(process.execPath, ["--disable-sigusr1"]);
    const pid = child.pid!;
    for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
      expect(statusMask(`/proc/${pid}/task/${task}/status`, "SigBlk") & SIGUSR1_BIT, `thread ${task}`).toBe(SIGUSR1_BIT);
    }
    expect(statusMask(`/proc/${pid}/status`, "SigCgt") & SIGUSR1_BIT).toBe(0n);

    process.kill(pid, "SIGUSR1");
    await new Promise((r) => setTimeout(r, 500));

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(await ping(child)).toBe(true);
    // Still pending: never delivered, so no debugger thread was started.
    expect(statusMask(`/proc/${pid}/status`, "ShdPnd") & SIGUSR1_BIT).toBe(SIGUSR1_BIT);
  }, 20_000);

  it("control: without the flag Node does catch SIGUSR1 (the debugger trigger)", async () => {
    const child = await startPingServer(process.execPath, []);
    expect(statusMask(`/proc/${child.pid}/status`, "SigCgt") & SIGUSR1_BIT).toBe(SIGUSR1_BIT);
  }, 20_000);
});

describe.skipIf(!isLinux || isRoot)("a server started from an unreadable copy of Node", () => {
  function executeOnlyNode(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dur3994-node-"));
    tempDirs.push(dir);
    const copy = path.join(dir, "node");
    fs.copyFileSync(process.execPath, copy);
    fs.chmodSync(copy, 0o111);
    return copy;
  }

  it("is not dumpable: another process of the same user cannot open its descriptors or environment", async () => {
    const child = await startPingServer(executeOnlyNode(), []);
    const pid = child.pid!;
    expect(() => fs.readdirSync(`/proc/${pid}/fd`)).toThrow(/EACCES|EPERM/);
    expect(() => fs.readFileSync(`/proc/${pid}/environ`)).toThrow(/EACCES|EPERM/);
    expect(() => fs.openSync(`/proc/${pid}/fd/0`, "r")).toThrow(/EACCES|EPERM/);
    // ...and it still works normally.
    expect(await ping(child)).toBe(true);
  }, 20_000);

  it("control: started from the ordinary readable Node, the same user can open them", async () => {
    const child = await startPingServer(process.execPath, []);
    expect(fs.readdirSync(`/proc/${child.pid}/fd`).length).toBeGreaterThan(0);
  }, 20_000);
});
