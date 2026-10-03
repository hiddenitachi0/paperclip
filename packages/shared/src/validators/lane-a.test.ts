import { describe, expect, it } from "vitest";
import {
  laneABackupModelsSchema,
  laneAChainIdsSchema,
  laneAKeywordRoutesSchema,
  laneABackupRoutingIssues,
} from "./lane-a.js";
import { createAgentSchema } from "./agent.js";
import type { LaneAProvider } from "../lane-a-models.js";

function backup(overrides: Partial<{ id: string; provider: LaneAProvider; model: string; baseUrl: string | null; temperature: number | null }> = {}) {
  return { id: "b1", provider: "openai" as LaneAProvider, model: "gpt-4.1-mini", ...overrides };
}

describe("laneABackupModelsSchema", () => {
  it("accepts up to 5 well-formed backup entries", () => {
    const pool = Array.from({ length: 5 }, (_, i) => backup({ id: `b${i}`, model: "gpt-4.1-mini" }));
    expect(laneABackupModelsSchema.safeParse(pool).success).toBe(true);
  });

  it("rejects more than 5 entries", () => {
    const pool = Array.from({ length: 6 }, (_, i) => backup({ id: `b${i}` }));
    const result = laneABackupModelsSchema.safeParse(pool);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids within the pool", () => {
    const result = laneABackupModelsSchema.safeParse([backup({ id: "dup" }), backup({ id: "dup" })]);
    expect(result.success).toBe(false);
  });

  it('rejects the reserved id "main"', () => {
    expect(laneABackupModelsSchema.safeParse([backup({ id: "main" })]).success).toBe(false);
  });

  it("rejects a model that does not fit a fixed-catalogue provider", () => {
    const result = laneABackupModelsSchema.safeParse([backup({ provider: "anthropic", model: "not-a-real-claude-model" })]);
    expect(result.success).toBe(false);
  });

  it("rejects a local entry with no base URL", () => {
    const result = laneABackupModelsSchema.safeParse([backup({ provider: "local", model: "llama3", baseUrl: undefined })]);
    expect(result.success).toBe(false);
  });

  it("accepts a local entry once a base URL is given", () => {
    const result = laneABackupModelsSchema.safeParse([
      backup({ provider: "local", model: "llama3", baseUrl: "http://localhost:11434/v1" }),
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts an openrouter entry with no base URL (OpenRouter has a usable default)", () => {
    const result = laneABackupModelsSchema.safeParse([backup({ provider: "openrouter", model: "anthropic/claude-3-haiku" })]);
    expect(result.success).toBe(true);
  });
});

describe("laneAChainIdsSchema", () => {
  it("accepts an ordered list of ids", () => {
    expect(laneAChainIdsSchema.safeParse(["b1", "b2"]).success).toBe(true);
  });

  it("rejects a duplicate id within one chain", () => {
    expect(laneAChainIdsSchema.safeParse(["b1", "b1"]).success).toBe(false);
  });
});

describe("laneAKeywordRoutesSchema", () => {
  it("accepts a well-formed rule", () => {
    expect(laneAKeywordRoutesSchema.safeParse([{ id: "r1", phrases: ["human", "person"], backupId: "b1" }]).success).toBe(true);
  });

  it("rejects a rule with no phrases", () => {
    expect(laneAKeywordRoutesSchema.safeParse([{ id: "r1", phrases: [], backupId: "b1" }]).success).toBe(false);
  });

  it("rejects an empty/blank phrase", () => {
    expect(laneAKeywordRoutesSchema.safeParse([{ id: "r1", phrases: [""], backupId: "b1" }]).success).toBe(false);
    expect(laneAKeywordRoutesSchema.safeParse([{ id: "r1", phrases: ["   "], backupId: "b1" }]).success).toBe(false);
  });

  it("rejects a duplicate phrase within the same rule (case-insensitive)", () => {
    expect(laneAKeywordRoutesSchema.safeParse([{ id: "r1", phrases: ["Human", "human"], backupId: "b1" }]).success).toBe(false);
  });
});

describe("laneABackupRoutingIssues (cross-field: chain/route ids must exist in the pool)", () => {
  const pool = [backup({ id: "b1" }), backup({ id: "b2" })];

  it("finds no issues when every chain/route id exists in the pool", () => {
    const issues = laneABackupRoutingIssues({
      laneABackupModels: pool,
      laneANoAnswerChainIds: ["b1", "b2"],
      laneARefusalChainIds: ["b2"],
      laneAKeywordRoutes: [{ id: "r1", phrases: ["human"], backupId: "b1" }],
    });
    expect(issues).toEqual([]);
  });

  it("flags a no-answer chain id that is not in the pool", () => {
    const issues = laneABackupRoutingIssues({ laneABackupModels: pool, laneANoAnswerChainIds: ["b1", "unknown"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["laneANoAnswerChainIds", 1]);
  });

  it("flags a refusal chain id that is not in the pool", () => {
    const issues = laneABackupRoutingIssues({ laneABackupModels: pool, laneARefusalChainIds: ["unknown"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["laneARefusalChainIds", 0]);
  });

  it("flags a keyword route whose backupId is not in the pool", () => {
    const issues = laneABackupRoutingIssues({
      laneABackupModels: pool,
      laneAKeywordRoutes: [{ id: "r1", phrases: ["human"], backupId: "unknown" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["laneAKeywordRoutes", 0, "backupId"]);
  });
});

describe("createAgentSchema: backup-model fields end to end", () => {
  function baseAgent(overrides: Record<string, unknown> = {}) {
    return { name: "Quick Agent", adapterType: "claude_local", adapterConfig: {}, ...overrides };
  }

  it("accepts a quick agent with a valid pool, chains and keyword routes", () => {
    const result = createAgentSchema.safeParse(
      baseAgent({
        laneABackupModels: [backup({ id: "b1" }), backup({ id: "b2", model: "gpt-4.1" })],
        laneANoAnswerChainIds: ["b1"],
        laneARefusalChainIds: ["b2"],
        laneAKeywordRoutes: [{ id: "r1", phrases: ["human"], backupId: "b2" }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a chain id that does not reference the pool sent in the same request", () => {
    const result = createAgentSchema.safeParse(
      baseAgent({
        laneABackupModels: [backup({ id: "b1" })],
        laneANoAnswerChainIds: ["b1", "does-not-exist"],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a pool of more than 5 backups", () => {
    const result = createAgentSchema.safeParse(
      baseAgent({ laneABackupModels: Array.from({ length: 6 }, (_, i) => backup({ id: `b${i}` })) }),
    );
    expect(result.success).toBe(false);
  });

  it("leaves every existing field untouched when none of the four backup fields are sent", () => {
    const result = createAgentSchema.safeParse(baseAgent());
    expect(result.success).toBe(true);
  });
});
