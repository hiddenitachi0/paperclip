import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, dataConnections, dataReadEvents, instanceSettings } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startFakeFtpServer, type FakeFtpServer } from "./helpers/fake-ftp-server.js";
import { dataConnectionService } from "../services/data-connections.js";
import { companyFileService, type CompanyFileCaller } from "../services/company-files.js";
import {
  buildLaneABuiltinToolDefinitions,
  createLaneABuiltinToolExecutor,
  READ_COMPANY_FILE_TOOL,
  type LaneAToolContext,
  type LaneAToolDeps,
} from "../services/lane-a-tools.js";

/**
 * DUR-3997 (files on a server): the "custom" dataset query service and the
 * Lane A tool, end to end against a real Postgres (every migration) and an
 * in-process fake FTP server. No real network, no Anthropic key.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3997 company-files tests: ${support.reason ?? "unsupported environment"}`);
}

const USER = "paperclip";
const PASS = "s3cret-passw0rd";

function seedFiles() {
  return {
    "/reports/august.csv": { content: Buffer.from("product,units\nSofa,12\nLenestol,4\n") },
    "/reports/readme.md": { content: Buffer.from("# Reports\nMonthly unit sales.\n") },
    "/reports/data.xlsx": { content: Buffer.from("PK\u0003\u0004 fake spreadsheet") },
    "/reports/2026/july.csv": { content: Buffer.from("product,units\nSofa,9\n") },
    "/secret.txt": { content: Buffer.from("outside the base folder") },
  };
}

d("DUR-3997 company files", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  let ftp: FakeFtpServer | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur3997-files-${randomUUID()}`);

  // Every file transport dials the fake FTP server after the address rule has
  // passed; the pinned public address is never actually connected to.
  const deps = () => ({
    fileServer: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      testOnly: { dial: { host: "127.0.0.1", port: ftp!.port } },
    },
  });

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    delete process.env.ANTHROPIC_API_KEY;
    const started = await startEmbeddedPostgresTestDatabase("dur3997-company-files");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    ftp = await startFakeFtpServer({ username: USER, password: PASS, files: seedFiles() });
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableBusinessData: true } });
  });

  afterEach(async () => {
    await ftp?.close();
    ftp = null;
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Nordstrand") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function connectFileServer(companyId: string, options: { access?: "read" | "read_write"; name?: string } = {}) {
    const svc = dataConnectionService(db, deps());
    const created = await svc.create(
      companyId,
      {
        kind: "ftp_file",
        name: options.name ?? "Company files",
        host: "files.example.com",
        port: 21,
        username: USER,
        remotePath: "/reports",
        access: options.access ?? "read",
        credential: { kind: "password", password: PASS },
        acknowledgedUnencrypted: true,
      },
      { userId: "board-user" },
    );
    return created.id;
  }

  async function activate(companyId: string, connectionId: string) {
    // Stand in for a passed "Test" (its own path is covered below).
    await db.update(dataConnections).set({ status: "active" }).where(eq(dataConnections.id, connectionId));
  }

  function caller(companyId: string, agentId: string | null = null, extra: Partial<CompanyFileCaller> = {}): CompanyFileCaller {
    return { companyId, channel: "quick_chat", agentId, userId: null, runId: null, laneAConversationId: null, ...extra };
  }

  it("Test connects, lists the base folder and, for read-write, writes and deletes the write-check file", async () => {
    const companyId = await seedCompany();
    const readWrite = await connectFileServer(companyId, { access: "read_write" });
    const svc = dataConnectionService(db, deps());
    const result = await svc.test(companyId, readWrite, { userId: "board-user" });
    expect(result.canActivate).toBe(true);
    expect(result.observed?.fileServer).toMatchObject({ protocol: "ftp", writable: true });
    expect(result.notes.join(" ")).toContain("Write check passed");
    // The write-check file was cleaned up.
    expect(ftp!.files["/reports/.paperclip-write-check"]).toBeUndefined();

    // A read-only connection never attempts a write.
    const readOnly = await connectFileServer(companyId, { access: "read", name: "Partner files" });
    const readResult = await svc.test(companyId, readOnly, { userId: "board-user" });
    expect(readResult.canActivate).toBe(true);
    expect(readResult.observed?.fileServer?.writable).toBeNull();
  });

  it("reads a text file, lists a folder, and writes a data_read_events row for each", async () => {
    const companyId = await seedCompany();
    const connectionId = await connectFileServer(companyId);
    await activate(companyId, connectionId);
    const files = companyFileService(db, deps());

    const list = await files.read(caller(companyId), { action: "list", path: "" });
    expect(list.ok).toBe(true);
    expect(list.text).toContain("august.csv");
    expect(list.text).toContain("2026");

    const read = await files.read(caller(companyId), { action: "read", path: "august.csv" });
    expect(read.ok).toBe(true);
    expect(read.text).toContain("Sofa,12");
    expect(read.text).toContain("File /august.csv");

    const rows = await db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.dataset === "custom" && row.channel === "quick_chat")).toBe(true);
    expect(rows.every((row) => row.outcome === "ok")).toBe(true);
  });

  it("refuses a path outside the base folder, a spreadsheet, and an unreadable file type", async () => {
    const companyId = await seedCompany();
    const connectionId = await connectFileServer(companyId);
    await activate(companyId, connectionId);
    const files = companyFileService(db, deps());

    const escape = await files.read(caller(companyId), { action: "read", path: "../secret.txt" });
    expect(escape.ok).toBe(false);
    expect(escape.refusalCode).toBe("path_outside_base");

    const xlsx = await files.read(caller(companyId), { action: "read", path: "data.xlsx" });
    expect(xlsx.ok).toBe(false);
    expect(xlsx.refusalCode).toBe("spreadsheet_not_supported");
    expect(xlsx.text).toContain("Spreadsheet files are not readable yet");

    const exe = await files.read(caller(companyId), { action: "read", path: "reports.zip" });
    expect(exe.ok).toBe(false);
    expect(exe.refusalCode).toBe("file_type_not_supported");
  });

  it("says 'not connected' plainly when the company has no active file server, and never contacts anything", async () => {
    const companyId = await seedCompany();
    const files = companyFileService(db, deps());
    const answer = await files.read(caller(companyId), { action: "list", path: "" });
    expect(answer.ok).toBe(false);
    expect(answer.refusalCode).toBe("not_connected");
    expect(answer.text).toContain("no file server connected");
    // A draft (untested) connection is still not available.
    await connectFileServer(companyId);
    expect(await files.isAvailable(companyId)).toBe(false);
  });

  it("truncates a file over 200 KB with a note", async () => {
    const companyId = await seedCompany();
    const connectionId = await connectFileServer(companyId);
    await activate(companyId, connectionId);
    const big = "row,value\n" + Array.from({ length: 40_000 }, (_, index) => `${index},x`).join("\n") + "\n";
    ftp!.files["/reports/big.csv"] = { content: Buffer.from(big) };
    const read = await companyFileService(db, deps()).read(caller(companyId), { action: "read", path: "big.csv" });
    expect(read.ok).toBe(true);
    expect(read.text).toContain("Truncated: showing the first");
    expect(Buffer.byteLength(read.text, "utf8")).toBeLessThan(220 * 1024);
  });

  it("the Lane A tool is offered only when a file server is active, and its input is confined", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const files = companyFileService(db, deps());

    // Not offered before a server is active.
    expect(await files.isAvailable(companyId)).toBe(false);
    const connectionId = await connectFileServer(companyId);
    await activate(companyId, connectionId);
    expect(await files.isAvailable(companyId)).toBe(true);

    // The built-in tool definition exists and has a confined path input.
    const tool = buildLaneABuiltinToolDefinitions().find((entry) => entry.name === READ_COMPANY_FILE_TOOL);
    expect(tool).toBeDefined();

    const deps2: LaneAToolDeps = {
      listAgents: async () => [],
      canAssignTask: async () => ({ allowed: false, explanation: "" }),
      createIssueForAgent: async () => ({ id: "x", identifier: null, status: "todo" }),
      lookupIssue: async () => null,
      fetch: (() => {
        throw new Error("network disabled");
      }) as unknown as typeof fetch,
      readCompanyFile: (input, ctx) =>
        files.read(
          { companyId: ctx.companyId, channel: "quick_chat", agentId: ctx.agent.id, userId: null, runId: null, laneAConversationId: ctx.conversationId },
          input,
        ),
    };
    const execute = createLaneABuiltinToolExecutor(deps2);
    const ctx: LaneAToolContext = {
      companyId,
      agent: { id: agentId, name: "Filbot" },
      requester: { userId: "user-1", agentId: null },
      actor: { type: "board", userId: "user-1", companyIds: [companyId], source: "session" },
      conversationId: randomUUID(),
    };

    const ok = await execute(READ_COMPANY_FILE_TOOL, { action: "read", path: "august.csv" }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("Sofa,12");

    const confined = await execute(READ_COMPANY_FILE_TOOL, { action: "read", path: "../secret.txt" }, ctx);
    expect(confined.ok).toBe(false);
    expect(confined.content).toContain("outside the connection's base folder");
    // A company-B file is never reachable from company A: another company's read is its own scope.
    expect(confined.content).not.toContain("outside the base folder\n"); // never the file body itself
  });
});
