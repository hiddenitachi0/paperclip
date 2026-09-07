import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "11111111-1111-4111-8111-111111111111";

const mockInboxDismissalService = vi.hoisted(() => ({
  list: vi.fn(),
  dismiss: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  inboxDismissalService: () => mockInboxDismissalService,
  logActivity: mockLogActivity,
}));

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { inboxDismissalRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/inbox-dismissals.js") as Promise<typeof import("../routes/inbox-dismissals.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", inboxDismissalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("inbox dismissal routes: item keys", () => {
  beforeEach(() => {
    mockInboxDismissalService.dismiss.mockReset();
    mockInboxDismissalService.dismiss.mockImplementation(async (_companyId: string, userId: string, itemKey: string, dismissedAt: Date) => ({
      id: "dismissal-1",
      companyId,
      userId,
      itemKey,
      dismissedAt,
    }));
    mockLogActivity.mockClear();
  });

  it.each([
    "approval:approval-1",
    "run:run-1",
    // DUR-62: hides one weekly check-up finding for a month.
    "checkup-finding:agent_error:44444444-4444-4444-8444-444444444444",
    "checkup-finding:stuck_issues",
  ])("accepts %s", async (itemKey) => {
    const res = await request(await createApp()).post(`/api/companies/${companyId}/inbox-dismissals`).send({ itemKey });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.itemKey).toBe(itemKey);
    expect(mockInboxDismissalService.dismiss).toHaveBeenCalledWith(companyId, "user-1", itemKey, expect.any(Date));
  });

  it.each(["issue:issue-1", "checkup-finding:", "checkup:stuck_issues", "anything"])("rejects %s", async (itemKey) => {
    const res = await request(await createApp()).post(`/api/companies/${companyId}/inbox-dismissals`).send({ itemKey });

    expect(res.status).toBe(400);
    expect(mockInboxDismissalService.dismiss).not.toHaveBeenCalled();
  });
});
