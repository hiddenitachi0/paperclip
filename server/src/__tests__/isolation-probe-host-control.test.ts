/**
 * DUR-5182: stage 7 of scripts/isolation-probe.sh ("host control").
 *
 * The probe runs inside an agent run in the live acceptance test; these tests
 * pin its logic with stand-in inputs (a fake docker command, a planted SSH
 * key, a fake mount list, fake database tools), including a negative control
 * for every check: the probe must see the planted problem.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PROBE = path.join(REPO_ROOT, "scripts", "isolation-probe.sh");
const isLinux = process.platform === "linux";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe7-"));
  tempDirs.push(dir);
  return dir;
}

// A folder that is NOT under /tmp (the probe allows temporary space).
function nonTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, ".probe7-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

type Options = {
  env?: Record<string, string>;
  fakeDocker?: boolean;
  // "unreachable" | "default-login-works" | "default-login-refused" | "missing"
  db?: "unreachable" | "default-login-works" | "default-login-refused" | "missing";
  mountinfo?: string;
  sshDirs?: string;
};

function runProbe(opts: Options = {}) {
  const root = tempDir();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const empty = path.join(root, "empty-ssh");
  fs.mkdirSync(empty);
  const mountinfo = path.join(root, "mountinfo");
  fs.writeFileSync(mountinfo, opts.mountinfo ?? "1 0 0:1 / / rw - overlay overlay rw\n");

  if (opts.fakeDocker) writeExecutable(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n");
  const db = opts.db ?? "unreachable";
  if (db !== "missing") {
    writeExecutable(path.join(bin, "pg_isready"), db === "unreachable" ? "#!/bin/sh\nexit 2\n" : "#!/bin/sh\nexit 0\n");
    writeExecutable(path.join(bin, "psql"), db === "default-login-works" ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\nexit 2\n");
  }

  // Real PATH is kept (the probe needs sh, grep, find ...). Make sure a real
  // docker/psql on this machine cannot leak into the "clean" runs: put fakes
  // first, and for "missing" shadow nothing but rely on the check below.
  // Pin the working directory: the probe treats its own cwd as the agent's
  // workspace (allowed), so it must not depend on where vitest was started.
  const result = spawnSync("sh", [PROBE], {
    encoding: "utf8",
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      TMPDIR: root,
      PROBE_ONLY_STAGE: "7",
      PROBE_ENFORCED_STAGES: "7",
      PROBE_DOCKER_SOCKETS: path.join(root, "no-such.sock"),
      PROBE_SSH_DIRS: opts.sshDirs ?? empty,
      PROBE_MOUNTINFO: mountinfo,
      PAPERCLIP_HOME: path.join(root, "pc-home"),
      ...opts.env,
    },
  });
  return { ...result, root, report: result.stdout.split("\n").filter(Boolean) };
}

describe.skipIf(!isLinux)("isolation probe stage 7: host control", () => {
  it("passes every check when nothing is reachable", () => {
    const r = runProbe({ db: "unreachable" });
    expect(r.report).toContain("PASS 7 docker no-socket-no-host-no-cli");
    expect(r.report).toContain("PASS 7 ssh-keys no-readable-private-key");
    expect(r.report.some((l) => l.startsWith("PASS 7 db-reachable"))).toBe(true);
    expect(r.report.some((l) => l.startsWith("PASS 7 host-writable"))).toBe(true);
    expect(r.report.at(-1)).toMatch(/^SUMMARY leaks=0 /);
    expect(r.status).toBe(0);
  });

  it("negative control: DOCKER_HOST is a leak", () => {
    const r = runProbe({ env: { DOCKER_HOST: "unix:///var/run/docker.sock" } });
    expect(r.report).toContain("LEAK 7 docker-host DOCKER_HOST");
    expect(r.status).toBe(1);
  });

  it("negative control: a docker socket is a leak", () => {
    const root = tempDir();
    const sock = path.join(root, "docker.sock");
    fs.writeFileSync(sock, "");
    const r = runProbe({ env: { PROBE_DOCKER_SOCKETS: sock } });
    expect(r.report).toContain(`LEAK 7 docker-socket ${sock}`);
    expect(r.status).toBe(1);
  });

  it("negative control: a docker command is a leak", () => {
    const r = runProbe({ fakeDocker: true });
    expect(r.report.some((l) => l.startsWith("LEAK 7 docker-cli "))).toBe(true);
    expect(r.status).toBe(1);
  });

  it("negative control: a readable SSH private key is a leak, and its content is never printed", () => {
    const sshDir = path.join(tempDir(), ".ssh");
    fs.mkdirSync(sshDir);
    fs.writeFileSync(
      path.join(sshDir, "id_test"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYBODY123\n-----END OPENSSH PRIVATE KEY-----\n",
    );
    fs.writeFileSync(path.join(sshDir, "known_hosts"), "example.com ssh-ed25519 AAAA\n");
    const r = runProbe({ sshDirs: sshDir });
    expect(r.report).toContain(`LEAK 7 ssh-private-key ${path.join(sshDir, "id_test")}`);
    expect(r.report.join("\n")).not.toContain("known_hosts");
    expect(r.stdout).not.toContain("SECRETKEYBODY123");
    expect(r.status).toBe(1);
  });

  it("a forwarded SSH agent is a leak", () => {
    const r = runProbe({ env: { SSH_AUTH_SOCK: "/tmp/agent.sock" } });
    expect(r.report).toContain("LEAK 7 ssh-agent SSH_AUTH_SOCK");
  });

  it("a known_hosts-only .ssh folder is clean", () => {
    const sshDir = path.join(tempDir(), ".ssh");
    fs.mkdirSync(sshDir);
    fs.writeFileSync(path.join(sshDir, "known_hosts"), "example.com ssh-ed25519 AAAA\n");
    const r = runProbe({ sshDirs: sshDir });
    expect(r.report).toContain("PASS 7 ssh-keys no-readable-private-key");
  });

  it("negative control: a default owner login that works is a known gap, not a failure", () => {
    const r = runProbe({ db: "default-login-works" });
    expect(r.report).toContain("KNOWN_GAP 7 db-reachable db:5432");
    expect(r.report).toContain("KNOWN_GAP 7 db-owner-default-login db:5432");
    expect(r.report.at(-1)).toMatch(/^SUMMARY leaks=0 known_gaps=2 /);
    expect(r.status).toBe(0);
  });

  it("the default owner login becomes a leak once the rotation has run", () => {
    const r = runProbe({ db: "default-login-works", env: { PROBE_DB_DEFAULT_LOGIN_ENFORCED: "1" } });
    expect(r.report).toContain("LEAK 7 db-owner-default-login db:5432");
    expect(r.status).toBe(1);
  });

  it("a refused default login passes even though the database is reachable", () => {
    const r = runProbe({ db: "default-login-refused" });
    expect(r.report).toContain("KNOWN_GAP 7 db-reachable db:5432");
    expect(r.report).toContain("PASS 7 db-owner-default-login default-credentials-refused");
    expect(r.status).toBe(0);
  });

  it("negative control: a writable host mount outside the allowed folders is a leak", () => {
    const hostDir = nonTmpDir();
    const allowed = nonTmpDir();
    const mountinfo = [
      "1 0 0:1 / / rw - overlay overlay rw",
      `2 1 8:1 /srv/host ${hostDir} rw - ext4 /dev/sda1 rw`,
      `3 1 8:1 /data ${allowed} rw - ext4 /dev/sda1 rw`,
      `4 1 8:1 /ro ${os.tmpdir()}/does-not-matter ro,relatime - ext4 /dev/sda1 ro`,
    ].join("\n");
    const r = runProbe({ mountinfo, env: { PAPERCLIP_HOME: allowed } });
    expect(r.report).toContain(`LEAK 7 host-writable ${hostDir}`);
    expect(r.report.join("\n")).not.toContain(`host-writable ${allowed}`);
    expect(r.status).toBe(1);
  });

  it("a read-only mount is clean", () => {
    const hostDir = nonTmpDir();
    const r = runProbe({ mountinfo: `2 1 8:1 /srv/host ${hostDir} ro,relatime - ext4 /dev/sda1 ro\n` });
    expect(r.report.some((l) => l.startsWith("PASS 7 host-writable"))).toBe(true);
  });

  it("a mount list it cannot read is a failure, never a silent pass", () => {
    const r = runProbe({ env: { PROBE_MOUNTINFO: "/nonexistent/mountinfo" } });
    expect(r.report).toContain("FAIL 7 host-writable cannot-read-mountinfo");
    expect(r.status).toBe(1);
  });
});
