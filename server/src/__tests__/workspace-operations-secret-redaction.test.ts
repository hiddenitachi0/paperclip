import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workspaceOperationService } from "../services/workspace-operations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-operations redaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-372: workspace_operations.stdoutExcerpt/stderrExcerpt/metadata were
// only passing through username/homedir redaction (redactCurrentUserText),
// never the known-leaked-secret-pattern gate DUR-317 added for
// heartbeat_runs -- e.g. a failing `git clone
// https://x-access-token:<PAT>@github.com/...` wrote the raw PAT straight
// into this table. This test proves the persisted row is scrubbed.
describeEmbeddedPostgres("workspace operation secret redaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logBasePath: string;
  let previousLogBasePath: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-op-redaction-");
    db = createDb(tempDb.connectionString);
    previousLogBasePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    logBasePath = mkdtempSync(path.join(os.tmpdir(), "workspace-op-logs-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logBasePath;
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousLogBasePath === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = previousLogBasePath;
    rmSync(logBasePath, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("redacts a leaked github token from stderr before it is persisted", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    const recorder = service.createRecorder({ companyId });

    const leaked = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const operation = await recorder.recordOperation({
      phase: "git_push", // paperclip:allow-git-push: test fixture label only; run() below is mocked and never shells out
      command: "git push", // paperclip:allow-git-push: test fixture label only; run() below is mocked and never shells out
      run: async () => ({
        status: "failed",
        exitCode: 128,
        stderr: `remote: Invalid username or token. fatal: Authentication failed for token ${leaked}`,
      }),
    });

    expect(operation.stderrExcerpt).not.toContain(leaked);
    expect(operation.stderrExcerpt).toContain("[REDACTED:github_token]");

    const persisted = await service.getById(operation.id);
    expect(persisted?.stderrExcerpt).not.toContain(leaked);
    expect(persisted?.stderrExcerpt).toContain("[REDACTED:github_token]");
  });

  it("redacts a leaked secret embedded in operation metadata", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    const recorder = service.createRecorder({ companyId });

    const leaked = "AKIAABCDEFGHIJKLMNOP";
    const operation = await recorder.recordOperation({
      phase: "git_clone",
      metadata: { remoteUrl: `https://${leaked}@github.com/acme/app.git` },
      run: async () => ({ status: "succeeded" }),
    });

    expect(JSON.stringify(operation.metadata)).not.toContain(leaked);
    expect(JSON.stringify(operation.metadata)).toContain("[REDACTED:aws_access_key_id]");
  });
});
