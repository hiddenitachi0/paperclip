import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AGENT_AVATAR_BYTES } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    name: "ClaudeCoder",
    avatarAssetId: null,
    ...overrides,
  };
}

const {
  createAssetMock,
  getAssetByIdMock,
  decideMock,
  getAgentByIdMock,
  logActivityMock,
} = vi.hoisted(() => ({
  createAssetMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  decideMock: vi.fn(),
  getAgentByIdMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    assetService: vi.fn(() => ({
      create: createAssetMock,
      getById: getAssetByIdMock,
    })),
    accessService: vi.fn(() => ({
      decide: decideMock,
    })),
    agentService: vi.fn(() => ({
      getById: getAgentByIdMock,
    })),
    logActivity: logActivityMock,
  }));
}

type TxSpy = {
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  updateCalls: Array<{ set: Record<string, unknown> }>;
  deleteCalls: Array<{ id: unknown }>;
};

function createTxSpy(): TxSpy {
  const updateCalls: TxSpy["updateCalls"] = [];
  const deleteCalls: TxSpy["deleteCalls"] = [];
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updateCalls.push({ set: values });
      return { where: vi.fn(() => Promise.resolve()) };
    }),
  }));
  const del = vi.fn((_table: unknown) => ({
    where: vi.fn((condition: { queryChunks?: unknown[] }) => {
      deleteCalls.push({ id: condition });
      return Promise.resolve();
    }),
  }));
  return { update, delete: del, updateCalls, deleteCalls };
}

function createDbStub(existingAgent: Record<string, unknown> | null) {
  const tx = createTxSpy();
  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(existingAgent ? [existingAgent] : [])),
    })),
  }));
  return { select, transaction, tx };
}

function createStorage(): StorageService & { deleteObjectMock: ReturnType<typeof vi.fn> } {
  const deleteObjectMock = vi.fn().mockResolvedValue(undefined);
  return {
    provider: "local_disk" as const,
    putFile: vi.fn(async (input) => ({
      provider: "local_disk" as const,
      objectKey: `${input.namespace}/generated`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: deleteObjectMock,
    deleteObjectMock,
  };
}

async function createApp(
  db: ReturnType<typeof createDbStub>,
  storage: StorageService,
  actor: Record<string, unknown>,
) {
  const { assetRoutes } = await vi.importActual<typeof import("../routes/assets.js")>("../routes/assets.js");
  const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use("/api", assetRoutes(db as any, storage));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "user-1",
};

const viewerActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-viewer",
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "viewer" }],
};

const agentActor = {
  type: "agent" as const,
  source: "agent_key" as const,
  companyId,
  agentId: "other-agent",
};

describe("agent avatar routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    decideMock.mockResolvedValue({ allowed: true });
    getAgentByIdMock.mockResolvedValue(agentRow({ avatarAssetId: "asset-new" }));
  });

  describe("POST /api/companies/:companyId/agents/:agentId/avatar", () => {
    it("rejects agent-authenticated callers with 403 before touching the agent row", async () => {
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, agentActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("png"), "avatar.png");

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it("returns 404 when the agent belongs to another company", async () => {
      const db = createDbStub(agentRow({ companyId: otherCompanyId }));
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("png"), "avatar.png");

      expect(res.status).toBe(404);
      expect(storage.putFile).not.toHaveBeenCalled();
    });

    it("returns 403 for a viewer board member", async () => {
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, viewerActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("png"), "avatar.png");

      expect(res.status).toBe(403);
    });

    it("returns 403 when access.decide refuses agent_config:update", async () => {
      decideMock.mockResolvedValue({ allowed: false, explanation: "Not permitted" });
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("png"), "avatar.png");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Not permitted");
    });

    it("rejects uploads over MAX_AGENT_AVATAR_BYTES with a plain sentence", async () => {
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.alloc(MAX_AGENT_AVATAR_BYTES + 1, "a"), "too-big.png");

      expect(res.status).toBe(422);
      expect(res.body.error).toBe(`Image exceeds ${MAX_AGENT_AVATAR_BYTES} bytes`);
      expect(createAssetMock).not.toHaveBeenCalled();
    });

    it("accepts an upload under MAX_AGENT_AVATAR_BYTES", async () => {
      createAssetMock.mockResolvedValue({ id: "asset-new", contentType: "image/png", byteSize: 1_900_000 });
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.alloc(1_900_000, "a"), "avatar.png");

      expect(res.status).toBe(201);
      expect(createAssetMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a PDF upload even though generic attachment rules would allow it", async () => {
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("%PDF-1.4"), { filename: "avatar.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(422);
      expect(createAssetMock).not.toHaveBeenCalled();
    });

    it("sanitizes an SVG upload, stripping <script> and external href", async () => {
      createAssetMock.mockResolvedValue({ id: "asset-new", contentType: "image/svg+xml", byteSize: 100 });
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach(
          "file",
          Buffer.from(
            "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><script>alert(1)</script><a href='https://evil.example/'><circle cx='12' cy='12' r='10'/></a></svg>",
          ),
          "avatar.svg",
        );

      expect(res.status).toBe(201);
      const stored = (storage.putFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const body = stored.body.toString("utf8");
      expect(body).toContain("<svg");
      expect(body).not.toContain("<script");
      expect(body).not.toContain("onload=");
      expect(body).not.toContain("https://evil.example/");
    });

    it("replaces an existing picture: deletes the old asset row and stored object, keeps exactly one", async () => {
      getAssetByIdMock.mockResolvedValue({ id: "asset-old", objectKey: "assets/agents/old.png" });
      createAssetMock.mockResolvedValue({ id: "asset-new", contentType: "image/png", byteSize: 100 });
      const db = createDbStub(agentRow({ avatarAssetId: "asset-old" }));
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("png"), "avatar.png");

      expect(res.status).toBe(201);
      expect(createAssetMock).toHaveBeenCalledTimes(1);
      expect(db.tx.deleteCalls).toHaveLength(1);
      expect(storage.deleteObject).toHaveBeenCalledWith(companyId, "assets/agents/old.png");
      expect(db.tx.updateCalls[0].set).toMatchObject({ avatarAssetId: "asset-new" });
    });

    it("stores the new asset under the assets/agents namespace", async () => {
      createAssetMock.mockResolvedValue({ id: "asset-new", contentType: "image/png", byteSize: 100 });
      const db = createDbStub(agentRow());
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/avatar`)
        .attach("file", Buffer.from("png"), "avatar.png");

      expect(storage.putFile).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: "assets/agents", companyId }),
      );
    });
  });

  describe("DELETE /api/companies/:companyId/agents/:agentId/avatar", () => {
    it("clears the column, deletes the asset row, and deletes the stored object", async () => {
      getAssetByIdMock.mockResolvedValue({ id: "asset-old", objectKey: "assets/agents/old.png" });
      const db = createDbStub(agentRow({ avatarAssetId: "asset-old" }));
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app).delete(`/api/companies/${companyId}/agents/${agentId}/avatar`);

      expect(res.status).toBe(200);
      expect(db.tx.updateCalls[0].set).toMatchObject({ avatarAssetId: null });
      expect(db.tx.deleteCalls).toHaveLength(1);
      expect(storage.deleteObject).toHaveBeenCalledWith(companyId, "assets/agents/old.png");
    });

    it("is a no-op when the agent has no avatar", async () => {
      const db = createDbStub(agentRow({ avatarAssetId: null }));
      const storage = createStorage();
      const app = await createApp(db, storage, boardActor);

      const res = await request(app).delete(`/api/companies/${companyId}/agents/${agentId}/avatar`);

      expect(res.status).toBe(200);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it("rejects agent-authenticated callers with 403", async () => {
      const db = createDbStub(agentRow({ avatarAssetId: "asset-old" }));
      const storage = createStorage();
      const app = await createApp(db, storage, agentActor);

      const res = await request(app).delete(`/api/companies/${companyId}/agents/${agentId}/avatar`);

      expect(res.status).toBe(403);
    });
  });
});
