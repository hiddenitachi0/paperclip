import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployRunnerStatusEntry } from "../services/deploy-runner-status.js";

// DUR-4235: live tail of the deploy runner's status feed over SSE.
//
// The poll interval is shrunk via env var (read once at module load in
// deploy-runner.ts) so this test observes a real poll tick instead of
// sleeping through the production 2s cadence.
process.env.PAPERCLIP_DEPLOY_RUNNER_STREAM_POLL_MS = "20";
process.env.PAPERCLIP_DEPLOY_RUNNER_STREAM_HEARTBEAT_MS = "100000";

const mockReadDeployRunnerStatus = vi.hoisted(() =>
  vi.fn((_companyId: string, _limit?: number) => [] as DeployRunnerStatusEntry[]),
);
vi.mock("../services/deploy-runner-status.js", () => ({
  readDeployRunnerStatus: (...args: [string, number?]) => mockReadDeployRunnerStatus(...args),
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

function entry(overrides: Partial<DeployRunnerStatusEntry> & { approvalId: string; ts: string }): DeployRunnerStatusEntry {
  return { companyId: COMPANY_ID, commentDelivered: true, body: "working...", ...overrides };
}

async function createServer(actor?: Record<string, unknown>) {
  const { deployRunnerRoutes } = await import("../routes/deploy-runner.js");
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", deployRunnerRoutes({} as any));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/** Collects SSE `data:` lines off the raw response until `want` of them arrive. */
function collectEvents(port: number, path: string, want: number) {
  return new Promise<{ events: any[]; req: http.ClientRequest; res: http.IncomingMessage }>((resolve, reject) => {
    const events: any[] = [];
    let buf = "";
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          events.push(JSON.parse(trimmed.slice("data:".length).trim()));
          if (events.length >= want) resolve({ events, req, res });
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

describe("GET /companies/:companyId/deploy-runner/status/stream", () => {
  let server: http.Server;
  let port: number;

  beforeEach(() => {
    mockReadDeployRunnerStatus.mockReset();
  });

  afterEach(() => {
    server?.close();
  });

  it("sends an initial snapshot on connect", async () => {
    mockReadDeployRunnerStatus.mockReturnValue([
      entry({ approvalId: "a1", ts: "2026-09-01T10:00:00Z", body: "Deploy started" }),
    ]);
    ({ server, port } = await createServer());

    const { events, req } = await collectEvents(port, `/api/companies/${COMPANY_ID}/deploy-runner/status/stream`, 1);
    expect(events[0]).toEqual({
      type: "snapshot",
      entries: [entry({ approvalId: "a1", ts: "2026-09-01T10:00:00Z", body: "Deploy started" })],
    });
    req.destroy();
  });

  it("only forwards entries newer than the last one already sent, on a single connection", async () => {
    mockReadDeployRunnerStatus.mockReturnValue([
      entry({ approvalId: "a1", ts: "2026-09-01T10:00:00Z", body: "Deploy started" }),
    ]);
    ({ server, port } = await createServer());

    const collected: any[] = [];
    let buf = "";
    const req = http.get(
      { host: "127.0.0.1", port, path: `/api/companies/${COMPANY_ID}/deploy-runner/status/stream` },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.startsWith("data:")) collected.push(JSON.parse(trimmed.slice("data:".length).trim()));
          }
        });
      },
    );

    // Wait for the snapshot.
    await vi.waitFor(() => expect(collected.length).toBeGreaterThanOrEqual(1));
    expect(collected[0].type).toBe("snapshot");

    // Append a new line and let a poll tick pick it up.
    mockReadDeployRunnerStatus.mockReturnValue([
      entry({ approvalId: "a1", ts: "2026-09-01T10:00:00Z", body: "Deploy started" }),
      entry({ approvalId: "a1", ts: "2026-09-01T10:00:05Z", body: "Deployed — commit abc123 is live and healthy", outcome: "deployed" }),
    ]);
    await vi.waitFor(() => expect(collected.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(collected[1]).toEqual({
      type: "entries",
      entries: [entry({ approvalId: "a1", ts: "2026-09-01T10:00:05Z", body: "Deployed — commit abc123 is live and healthy", outcome: "deployed" })],
    });

    // A poll with no new lines beyond lastSeenTs must not emit again.
    await new Promise((r) => setTimeout(r, 100));
    expect(collected.length).toBe(2);

    req.destroy();
  });

  it("filters to a single approval when approvalId is given", async () => {
    mockReadDeployRunnerStatus.mockReturnValue([
      entry({ approvalId: "a1", ts: "2026-09-01T10:00:00Z" }),
      entry({ approvalId: "a2", ts: "2026-09-01T10:00:01Z" }),
    ]);
    ({ server, port } = await createServer());

    const { events, req } = await collectEvents(
      port,
      `/api/companies/${COMPANY_ID}/deploy-runner/status/stream?approvalId=a2`,
      1,
    );
    expect(events[0].entries.map((e: DeployRunnerStatusEntry) => e.approvalId)).toEqual(["a2"]);
    req.destroy();
  });

  it("refuses a caller without access to the company before writing any SSE data", async () => {
    ({ server, port } = await createServer({
      type: "board",
      userId: "user-2",
      companyIds: [OTHER_COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    }));

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: `/api/companies/${COMPANY_ID}/deploy-runner/status/stream` }, resolve);
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mockReadDeployRunnerStatus).not.toHaveBeenCalled();
    res.resume();
  });
});
