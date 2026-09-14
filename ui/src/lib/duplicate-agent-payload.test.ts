// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildDuplicateAgentPayload, duplicateAgentName } from "./duplicate-agent-payload";
import { DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS, type AgentDetail } from "@paperclipai/shared";

const baseAgent: AgentDetail = {
  id: "agent-1",
  companyId: "company-1",
  name: "Senior Product Engineer",
  urlKey: "senior-product-engineer",
  role: "engineer",
  title: "Senior Product Engineer",
  icon: "code",
  avatarAssetId: null,
  status: "idle",
  reportsTo: "manager-1",
  capabilities: "Builds product features.",
  adapterType: "codex_local",
  adapterConfig: {
    model: "gpt-5.5",
    instructionsBundleMode: "managed",
    instructionsRootPath: "/tmp/original/instructions",
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: "/tmp/original/instructions/AGENTS.md",
    promptTemplate: "legacy prompt",
    bootstrapPromptTemplate: "legacy bootstrap",
  },
  runtimeConfig: {
    heartbeat: { enabled: true },
  },
  defaultEnvironmentId: "environment-1",
  budgetMonthlyCents: 500,
  spentMonthlyCents: 123,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true, canCreateSkills: true },
  lastHeartbeatAt: null,
  metadata: { source: "test" },
  createdAt: new Date("2026-05-10T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
  chainOfCommand: [],
  access: {
    canAssignTasks: true,
    taskAssignSource: "explicit_grant",
    membership: null,
    grants: [],
  },
};

describe("duplicate agent payload", () => {
  it("suffixes duplicate names", () => {
    expect(duplicateAgentName("Senior Product Engineer")).toBe("Senior Product Engineer Copy");
    expect(duplicateAgentName("   ")).toBe("Agent Copy");
  });

  it("copies agent fields while removing original instruction paths", () => {
    const payload = buildDuplicateAgentPayload(baseAgent, {
      entryFile: "AGENTS.md",
      files: {
        "AGENTS.md": "You are a copy.",
      },
    });

    expect(payload).toMatchObject({
      name: "Senior Product Engineer Copy",
      role: "engineer",
      title: "Senior Product Engineer",
      icon: "code",
      reportsTo: "manager-1",
      capabilities: "Builds product features.",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.5" },
      runtimeConfig: { heartbeat: { enabled: true } },
      defaultEnvironmentId: "environment-1",
      budgetMonthlyCents: 500,
      permissions: { canCreateAgents: true, canCreateSkills: true },
      metadata: { source: "test" },
      instructionsBundle: {
        entryFile: "AGENTS.md",
        files: { "AGENTS.md": "You are a copy." },
      },
    });
    expect(payload.adapterConfig).not.toHaveProperty("instructionsFilePath");
    expect(payload.adapterConfig).not.toHaveProperty("promptTemplate");
  });
  // DUR-3971
  it("keeps a copy of a quick agent a quick agent", () => {
    const payload = buildDuplicateAgentPayload({
      ...baseAgent,
      laneAEnabled: true,
      laneAInstructions: "You are the front desk.",
    });

    expect(payload).toMatchObject({
      laneAEnabled: true,
      laneAInstructions: "You are the front desk.",
    });
  });

  it("writes nothing about the working style when copying an ordinary agent", () => {
    const payload = buildDuplicateAgentPayload(baseAgent);

    expect(Object.hasOwn(payload, "laneAEnabled")).toBe(false);
    expect(Object.hasOwn(payload, "laneAInstructions")).toBe(false);
  });
});

// DUR-3976: duplicating an agent must not quietly create a hire with no
// spending limit. Most existing agents predate the $50 default and carry 0, so
// copying that 0 would give the copy no limit without anyone choosing it.
describe("duplicate agent payload spending limit", () => {
  it("gives a copy of an agent with no limit the standard $50 limit", () => {
    const payload = buildDuplicateAgentPayload({ ...baseAgent, budgetMonthlyCents: 0 }, {
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": "You are a copy." },
    });
    expect(payload.budgetMonthlyCents).toBe(DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS);
    expect(payload.budgetMonthlyCents).toBe(5000);
  });

  it("keeps a real limit when copying an agent that has one", () => {
    const payload = buildDuplicateAgentPayload({ ...baseAgent, budgetMonthlyCents: 30000 }, {
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": "You are a copy." },
    });
    expect(payload.budgetMonthlyCents).toBe(30000);
  });
});
