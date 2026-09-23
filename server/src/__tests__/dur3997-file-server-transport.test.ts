import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DataSourceConnectionInfo } from "../services/data-sources/connection-kind.js";
import { resolveFileServerAddress, isSamePeerAddress } from "../services/data-sources/file-server/address.js";
import { FileServerError } from "../services/data-sources/file-server/errors.js";
import { connectFtp, parseListLine, parseMlsdLine, parseFtpTimestamp } from "../services/data-sources/file-server/ftp-client.js";
import { confineRemotePath, displayRemotePath } from "../services/data-sources/file-server/paths.js";
import { createFileServerOperations } from "../services/data-sources/file-server/operations.js";
import { connectSftp } from "../services/data-sources/file-server/sftp-client.js";
import type { FileServerSession } from "../services/data-sources/file-server/session.js";
import { getDataSourceKind, type OpenReadContextInput } from "../services/data-sources/registry.js";
import { startFakeFtpServer, type FakeFtpServer } from "./helpers/fake-ftp-server.js";
import { startFakeSftpServer, type FakeSftpServer } from "./helpers/fake-sftp-server.js";

/**
 * DUR-3997 (files on a server): the FTP client against an in-process fake FTP
 * server (net.createServer, no real network), the address rule, and path
 * confinement. No credential appears in any error the client raises.
 */

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const USER = "paperclip";
const PASS = "s3cret-passw0rd";

const files = () => ({
  "/reports/august.csv": { content: Buffer.from("product,units\nSofa,12\n") },
  "/reports/notes.txt": { content: Buffer.from("hello") },
  "/reports/2026/july.csv": { content: Buffer.from("product,units\nSofa,9\n") },
  "/secret.txt": { content: Buffer.from("outside the base folder") },
});

async function connect(server: FakeFtpServer, overrides: Record<string, unknown> = {}) {
  return connectFtp({
    host: "files.example.com",
    address: "93.184.216.34",
    port: server.port,
    secure: false,
    username: USER,
    password: PASS,
    testOnly: { dial: { host: "127.0.0.1", port: server.port } },
    ...overrides,
  });
}

describe("DUR-3997 FTP client", () => {
  let running: FakeFtpServer | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  it("logs in, lists MLSD, reads a file with its size, writes and deletes", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const session = await connect(running);
    try {
      const entries = await session.list("/reports");
      expect(entries.find((entry) => entry.name === "august.csv")).toMatchObject({ type: "file", size: 22 });
      expect(entries.find((entry) => entry.name === "2026")).toMatchObject({ type: "directory" });

      const read = await session.read("/reports/august.csv", 25 * 1024 * 1024);
      expect(read.bytes.toString("utf8")).toBe("product,units\nSofa,12\n");
      expect(read.size).toBe(22);

      await session.write("/reports/out.csv", Buffer.from("x,y\n1,2\n"));
      expect(running.files["/reports/out.csv"]?.content.toString("utf8")).toBe("x,y\n1,2\n");
      await session.remove("/reports/out.csv");
      expect(running.files["/reports/out.csv"]).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("works with LIST when MLSD is not offered", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), useMlsd: false });
    const session = await connect(running);
    try {
      const entries = await session.list("/reports");
      expect(entries.map((entry) => entry.name).sort()).toEqual(["2026", "august.csv", "notes.txt"]);
      expect(entries.find((entry) => entry.name === "august.csv")?.type).toBe("file");
    } finally {
      await session.close();
    }
  });

  it("refuses a passive-mode data connection to a different address than the control connection (FTP bounce)", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), pasvLieAddress: "8.8.8.8" });
    const session = await connect(running);
    try {
      const error = await session.list("/reports").then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(FileServerError);
      expect((error as FileServerError).code).toBe("bounce_refused");
    } finally {
      await session.close();
    }
  });

  it("refuses a wrong password, and the error never contains the password", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const error = await connect(running, { password: "the-wrong-one" }).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(FileServerError);
    expect((error as FileServerError).code).toBe("login_failed");
    expect((error as FileServerError).message).not.toContain("the-wrong-one");
  });

  it("refuses a file larger than the byte cap (from SIZE, before transfer)", async () => {
    const big = { "/reports/big.csv": { content: Buffer.alloc(2 * 1024 * 1024, 0x61) } };
    running = await startFakeFtpServer({ username: USER, password: PASS, files: { ...files(), ...big } });
    const session = await connect(running);
    try {
      const error = await session.read("/reports/big.csv", 1024).then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(FileServerError);
      expect((error as FileServerError).code).toBe("too_large");
    } finally {
      await session.close();
    }
  });

  it("reports a missing file as not_found", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const session = await connect(running);
    try {
      const error = await session.read("/reports/missing.csv", 1024).then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code).toBe("not_found");
    } finally {
      await session.close();
    }
  });
});

describe("DUR-3997 FTP client, confined through FileServerOperations", () => {
  let running: FakeFtpServer | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  // Connect lazily, exactly like the real service: a session is opened only
  // when the first operation needs it, and closed by ops.close(). A test that
  // never opens one (a refusal before any command) leaves no socket to close.
  function operations(server: FakeFtpServer, access: "read" | "read_write", maxRequests = 10) {
    return createFileServerOperations({
      basePath: "/reports",
      access,
      maxRequests,
      openSession: () => connect(server) as Promise<FileServerSession>,
    });
  }

  it("confines paths under the base folder and refuses climbing out", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const ops = operations(running, "read");
    try {
      const listing = await ops.list("");
      expect(listing.path).toBe("/reports");
      expect(displayRemotePath("/reports", listing.path)).toBe("/");
      const read = await ops.read("august.csv");
      expect(read.bytes.toString("utf8")).toContain("Sofa,12");
      for (const bad of ["../secret.txt", "/secret.txt", "/etc/passwd", "2026/../../secret.txt"]) {
        const error = await ops.read(bad).then(() => null, (err: unknown) => err);
        expect((error as FileServerError).code, bad).toBe("path_outside_base");
      }
    } finally {
      await ops.close();
    }
  });

  it("refuses a write on a read-only connection before any command is sent", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const ops = operations(running, "read");
    try {
      const error = await ops.write("blocked.csv", Buffer.from("x")).then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code).toBe("write_not_allowed");
      // Nothing was written on the server.
      expect(running.files["/reports/blocked.csv"]).toBeUndefined();
    } finally {
      await ops.close();
    }
  });

  it("allows write and delete on a read-write connection and counts operations against the budget", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const ops = operations(running, "read_write", 2);
    try {
      await ops.write("added.csv", Buffer.from("a,b\n"));
      expect(running.files["/reports/added.csv"]).toBeDefined();
      await ops.remove("added.csv");
      // The budget of 2 is now spent; a third operation is refused.
      const error = await ops.list("").then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code).toBe("request_budget_exceeded");
    } finally {
      await ops.close();
    }
  });
});

describe("DUR-3997 file-server address rule", () => {
  it("pins the resolved public address", async () => {
    const pinned = await resolveFileServerAddress("files.example.com", { lookup: PUBLIC });
    expect(pinned).toEqual({ host: "files.example.com", address: "93.184.216.34", family: 4 });
  });

  it("refuses a private or CGNAT address and an internal-looking name, without contacting anything", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "192.168.1.10", "100.64.1.1", "169.254.0.1"]) {
      const error = await resolveFileServerAddress("files.example.com", { lookup: async () => [{ address, family: 4 }] })
        .then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code, address).toBe("address_not_public");
    }
    for (const name of ["fileserver", "nas.local", "10.0.0.5", "localhost"]) {
      const error = await resolveFileServerAddress(name, { lookup: PUBLIC }).then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code, name).toBe("address_not_public");
    }
  });

  it("refuses a name where any resolved address is private (rebinding to a mix)", async () => {
    const error = await resolveFileServerAddress("files.example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
    }).then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("address_not_public");
  });

  it("treats an IPv4 and its IPv4-mapped IPv6 form as the same peer", () => {
    expect(isSamePeerAddress("93.184.216.34", "::ffff:93.184.216.34")).toBe(true);
    expect(isSamePeerAddress("93.184.216.34", "8.8.8.8")).toBe(false);
  });
});

describe("DUR-3997 path confinement", () => {
  it("resolves relative and absolute paths inside the base, and refuses the rest", () => {
    expect(confineRemotePath("/reports", "")).toBe("/reports");
    expect(confineRemotePath("/reports", "/")).toBe("/reports");
    expect(confineRemotePath("/reports", "august.csv")).toBe("/reports/august.csv");
    expect(confineRemotePath("/reports", "/reports/2026/july.csv")).toBe("/reports/2026/july.csv");
    expect(confineRemotePath("/reports", "2026/../august.csv")).toBe("/reports/august.csv");
    for (const bad of ["../secret", "/secret.txt", "/reports/../etc", "..", "reports\u0000/x", "a\r\nDELE x"]) {
      expect(() => confineRemotePath("/reports", bad), bad).toThrow(FileServerError);
    }
  });
});

describe("DUR-3997 FTP listing parsers", () => {
  it("parses MLSD facts", () => {
    expect(parseMlsdLine("type=file;size=42;modify=20260812101500; august.csv")).toEqual({
      name: "august.csv",
      type: "file",
      size: 42,
      modifiedAt: new Date(Date.UTC(2026, 7, 12, 10, 15, 0)),
    });
    expect(parseMlsdLine("type=dir;modify=20260101000000; 2026")).toMatchObject({ name: "2026", type: "directory" });
    expect(parseMlsdLine("type=cdir;modify=20260101000000; .")).toBeNull();
  });

  it("parses Unix and DOS LIST lines and drops . and ..", () => {
    expect(parseListLine("-rw-r--r-- 1 owner group 22 Jan 01 2026 august.csv")).toMatchObject({ name: "august.csv", type: "file", size: 22 });
    expect(parseListLine("drwxr-xr-x 2 owner group 4096 Jan 01 2026 2026")).toMatchObject({ name: "2026", type: "directory" });
    expect(parseListLine("01-02-26  10:15AM  <DIR>  reports")).toMatchObject({ name: "reports", type: "directory" });
    expect(parseListLine("total 8")).toBeNull();
    expect(parseListLine("drwxr-xr-x 2 o g 4096 Jan 01 2026 ..")).toBeNull();
  });

  it("parses an FTP timestamp", () => {
    expect(parseFtpTimestamp("20260812101500")).toEqual(new Date(Date.UTC(2026, 7, 12, 10, 15, 0)));
    expect(parseFtpTimestamp("not-a-time")).toBeNull();
  });
});

describe("DUR-3997 FTP client, a misbehaving server", () => {
  let running: FakeFtpServer | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  it("survives a data socket reset before the RETR reply: the 550 becomes not_found, nothing is unhandled, the session still works", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), resetDataOn: ["RETR"] });
    const session = await connect(running);
    try {
      const error = await session.read("/reports/august.csv", 1024 * 1024).then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code).toBe("not_found");
      // The control connection is intact: a later operation succeeds.
      const entries = await session.list("/reports");
      expect(entries.map((entry) => entry.name)).toContain("august.csv");
    } finally {
      await session.close();
    }
  });

  it("survives a data socket reset before the MLSD reply", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), resetDataOn: ["MLSD"] });
    const session = await connect(running);
    try {
      const error = await session.list("/reports").then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code).toBe("not_found");
    } finally {
      await session.close();
    }
  });

  it("a reset during the write check makes Test report writable=false and refuse activation, without crashing", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), resetDataOn: ["STOR"] });
    const server = running;
    const info: DataSourceConnectionInfo = {
      id: "c0000000-0000-4000-8000-000000000001",
      companyId: "a0000000-0000-4000-8000-000000000001",
      kind: "ftp_file",
      name: "Files",
      shopDomain: null,
      apiVersion: null,
      config: { kind: "ftp_file", host: "files.example.com", port: server.port, username: USER, remotePath: "/reports", acknowledgedUnencrypted: true },
      access: "read_write",
      hostKeyFingerprint: null,
      ianaTimezone: null,
      currencyCode: null,
      earliestVisibleOrderAt: null,
    };
    const secrets: string[] = [];
    const input: OpenReadContextInput = {
      connection: info,
      loadCredential: async () => ({ kind: "password", password: PASS }),
      budget: { maxRequests: 10, deadlineMs: 20_000 },
      knownSecrets: () => [...secrets],
      registerSecret: (value) => secrets.push(value),
      deps: { fileServer: { lookup: PUBLIC, testOnly: { dial: { host: "127.0.0.1", port: server.port } } } },
    };
    const outcome = await getDataSourceKind("ftp_file").check(input);
    expect(outcome.ok).toBe(true);
    expect(outcome.canActivate).toBe(false);
    expect(outcome.observed?.fileServer?.writable).toBe(false);
    expect(outcome.problems.join(" ")).toContain("Write check failed");
    expect(outcome.problems.join(" ")).not.toContain(PASS);
  });

  it("refuses a reply longer than any FTP reply instead of buffering it", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), oversizedReplyOn: "MLSD" });
    const session = await connect(running);
    try {
      const error = await session.list("/reports").then(() => null, (err: unknown) => err);
      expect((error as FileServerError).code).toBe("protocol_error");
    } finally {
      await session.close();
    }
  });

  it("tears down the control and data sockets when an operation hits its deadline, so the server can close", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), stallOn: "MLSD" });
    const session = await connect(running, { operationTimeoutMs: 300 });
    const startedAt = Date.now();
    const error = await session.list("/reports").then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await session.close();
    // afterEach closes the server; a leaked socket would make that hang.
  });

  it("stops a context at its own deadline and aborts the session", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), stallOn: "MLSD" });
    const server = running;
    const ops = createFileServerOperations({
      basePath: "/reports",
      access: "read",
      maxRequests: 5,
      deadlineMs: 400,
      openSession: () => connect(server) as Promise<FileServerSession>,
    });
    const error = await ops.list("").then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("timeout");
    // Past the deadline, nothing more is even started.
    const later = await ops.read("august.csv").then(() => null, (err: unknown) => err);
    expect((later as FileServerError).code).toBe("timeout");
    await ops.close();
  });
});

describe("DUR-3997 FTPS (explicit AUTH TLS) against the fake server", () => {
  let running: FakeFtpServer | null = null;
  let tls: { key: string; cert: string } | null = null;
  let tmp: string | null = null;

  beforeAll(() => {
    // A throwaway self-signed certificate for files.example.com, made at test
    // time with the system openssl; nothing is committed. Skipped if absent.
    try {
      tmp = mkdtempSync(path.join(os.tmpdir(), "paperclip-ftps-"));
      const keyPath = path.join(tmp, "key.pem");
      const certPath = path.join(tmp, "cert.pem");
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "30", "-subj", "/CN=files.example.com", "-addext", "subjectAltName=DNS:files.example.com"],
        { stdio: "ignore" },
      );
      tls = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
    } catch {
      tls = null;
      console.warn("Skipping FTPS tests: openssl is not available to make a test certificate");
    }
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  it("upgrades the control connection, encrypts data connections, verifies the certificate against the DNS name, and reads", async () => {
    if (!tls) return;
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), tls });
    const session = await connect(running, { secure: true, testOnly: { dial: { host: "127.0.0.1", port: running.port }, tls: { ca: tls.cert } } });
    try {
      expect(session.protocol).toBe("ftps");
      expect(running.commands.slice(0, 4)).toEqual(["AUTH", "PBSZ", "PROT", "USER"]);
      const entries = await session.list("/reports");
      expect(entries.map((entry) => entry.name)).toContain("august.csv");
      const read = await session.read("/reports/august.csv", 1024 * 1024);
      expect(read.bytes.toString("utf8")).toContain("Sofa,12");
      await session.write("/reports/tls.csv", Buffer.from("a\n"));
      expect(running.files["/reports/tls.csv"]?.content.toString("utf8")).toBe("a\n");
    } finally {
      await session.close();
    }
  });

  it("refuses a certificate that is not trusted, before the password is sent", async () => {
    if (!tls) return;
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files(), tls });
    // No CA given: the self-signed certificate is not trusted.
    const error = await connect(running, { secure: true }).then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("tls_failed");
    expect(running.loginAttempts).toHaveLength(0);
  });

  it("refuses a server that does not offer AUTH TLS", async () => {
    running = await startFakeFtpServer({ username: USER, password: PASS, files: files() });
    const error = await connect(running, { secure: true }).then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("tls_failed");
    expect(running.loginAttempts).toHaveLength(0);
  });
});

describe("DUR-3997 SFTP client against an in-process ssh2 server", () => {
  let running: FakeSftpServer | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  const sftpFiles = () => ({
    "/reports/august.csv": Buffer.from("product,units\nSofa,12\n"),
    "/reports/2026/july.csv": Buffer.from("product,units\nSofa,9\n"),
    "/secret.txt": Buffer.from("outside"),
  });

  async function sftp(server: FakeSftpServer, overrides: Record<string, unknown> = {}) {
    return connectSftp({
      host: "files.example.com",
      address: "93.184.216.34",
      port: server.port,
      username: USER,
      credential: { kind: "password", password: PASS },
      expectedHostKeyFingerprint: null,
      testOnly: { dial: { host: "127.0.0.1", port: server.port } },
      ...overrides,
    });
  }

  it("lists, reads (with size and mtime), writes and deletes, and reports the host-key fingerprint", async () => {
    running = await startFakeSftpServer({ username: USER, password: PASS, files: sftpFiles() });
    const session = await sftp(running);
    try {
      expect(session.protocol).toBe("sftp");
      expect(session.hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
      const entries = await session.list("/reports");
      expect(entries.find((entry) => entry.name === "august.csv")).toMatchObject({ type: "file", size: 22 });
      expect(entries.find((entry) => entry.name === "2026")).toMatchObject({ type: "directory" });
      const read = await session.read("/reports/august.csv", 1024 * 1024);
      expect(read.bytes.toString("utf8")).toBe("product,units\nSofa,12\n");
      expect(read.modifiedAt).toEqual(new Date(Date.UTC(2026, 0, 1)));
      await session.write("/reports/out.csv", Buffer.from("x,y\n"));
      expect(running.files["/reports/out.csv"]?.toString("utf8")).toBe("x,y\n");
      await session.remove("/reports/out.csv");
      expect(running.files["/reports/out.csv"]).toBeUndefined();
      const missing = await session.read("/reports/nope.csv", 1024).then(() => null, (err: unknown) => err);
      expect((missing as FileServerError).code).toBe("not_found");
    } finally {
      await session.close();
    }
    expect(running.authAttempts).toContain("password");
  });

  it("pins the host key: the recorded fingerprint is accepted, a different one is refused before any authentication attempt", async () => {
    running = await startFakeSftpServer({ username: USER, password: PASS, files: sftpFiles() });
    const first = await sftp(running);
    const fingerprint = first.hostKeyFingerprint!;
    await first.close();
    const attemptsBefore = running.authAttempts.length;

    const again = await sftp(running, { expectedHostKeyFingerprint: fingerprint });
    await again.close();

    const error = await sftp(running, { expectedHostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("host_key_mismatch");
    expect((error as FileServerError).message).toContain("not the one seen at the last Test");
    // The refused connection offered no password: only the accepted reconnect added attempts.
    const attemptsFromAccepted = running.authAttempts.length - attemptsBefore;
    expect(attemptsFromAccepted).toBeGreaterThan(0);
    running.authAttempts.length = 0;
    const errorAgain = await sftp(running, { expectedHostKeyFingerprint: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }).then(() => null, (err: unknown) => err);
    expect((errorAgain as FileServerError).code).toBe("host_key_mismatch");
    expect(running.authAttempts).toEqual([]);
  });

  it("refuses a wrong password without echoing it, and a file over the byte cap by its size before streaming", async () => {
    running = await startFakeSftpServer({ username: USER, password: PASS, files: { ...sftpFiles(), "/reports/big.csv": Buffer.alloc(300 * 1024, 0x61) } });
    const error = await sftp(running, { credential: { kind: "password", password: "the-wrong-one" } }).then(() => null, (err: unknown) => err);
    expect((error as FileServerError).code).toBe("login_failed");
    expect((error as FileServerError).message).not.toContain("the-wrong-one");

    const session = await sftp(running);
    try {
      const tooBig = await session.read("/reports/big.csv", 256 * 1024).then(() => null, (err: unknown) => err);
      expect((tooBig as FileServerError).code).toBe("too_large");
      expect((tooBig as FileServerError).message).toContain("300 KB");
    } finally {
      await session.close();
    }
  });
});
