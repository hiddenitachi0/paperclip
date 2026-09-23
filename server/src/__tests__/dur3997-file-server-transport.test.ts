import { afterEach, describe, expect, it } from "vitest";
import { resolveFileServerAddress, isSamePeerAddress } from "../services/data-sources/file-server/address.js";
import { FileServerError } from "../services/data-sources/file-server/errors.js";
import { connectFtp, parseListLine, parseMlsdLine, parseFtpTimestamp } from "../services/data-sources/file-server/ftp-client.js";
import { confineRemotePath, displayRemotePath } from "../services/data-sources/file-server/paths.js";
import { createFileServerOperations } from "../services/data-sources/file-server/operations.js";
import type { FileServerSession } from "../services/data-sources/file-server/session.js";
import { startFakeFtpServer, type FakeFtpServer } from "./helpers/fake-ftp-server.js";

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
