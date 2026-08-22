import { describe, expect, it } from "vitest";
import {
  agentSelfUpdateDisallowedFields,
  agentSelfUpdateDisallowedRuntimeConfigKeys,
  computeChangedConfigFields,
  configPatchFromSnapshot,
} from "../services/agent-self-update-policy.js";

// DUR-57: this module is the single shared layer both PATCH /agents/:id
// (assertAgentSelfUpdateAllowed) and the config-revision rollback route
// (assertAgentSelfUpdateRollbackAllowed) call through in server/src/routes/agents.ts.
// These tests exercise it directly so the "any field not explicitly
// allow-listed is refused by default, including one that doesn't exist yet"
// property is proven independent of either route's HTTP plumbing.

describe("agentSelfUpdateDisallowedFields", () => {
  it("keeps allow-listed fields and refuses everything else, including a field invented for this test", () => {
    const disallowed = agentSelfUpdateDisallowedFields({
      capabilities: "writes tests",
      desiredSkills: ["skill-a"],
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: { modelProfiles: {} },
      role: "ceo",
      reportsTo: "some-agent-id",
      budgetMonthlyCents: 1_000_000,
      name: "Renamed",
      title: "New Title",
      icon: "crown",
      personality: "Sassy and fun.",
      adapterType: "codex_local",
      defaultEnvironmentId: "env-id",
      metadata: { anything: true },
      status: "paused",
      spentMonthlyCents: 0,
      // Stands in for a field that gets added to updateAgentSchema in the
      // future without anyone touching the allow-list — it must come back
      // refused with zero changes to this module.
      aFieldNobodyHasWrittenYet: "surprise",
    });

    expect(disallowed.sort()).toEqual([
      "aFieldNobodyHasWrittenYet",
      "adapterType",
      "budgetMonthlyCents",
      "defaultEnvironmentId",
      "icon",
      "metadata",
      "personality",
      "name",
      "reportsTo",
      "role",
      "spentMonthlyCents",
      "status",
      "title",
    ].sort());
  });

  it("allows an empty patch", () => {
    expect(agentSelfUpdateDisallowedFields({})).toEqual([]);
  });
});

describe("agentSelfUpdateDisallowedRuntimeConfigKeys", () => {
  it("keeps modelProfiles and refuses every other runtimeConfig key, named or not", () => {
    const disallowed = agentSelfUpdateDisallowedRuntimeConfigKeys({
      modelProfiles: { cheap: { adapterConfig: {} } },
      handOffUnhandledAfterMinutes: 30,
      aFutureRuntimeConfigKey: "surprise",
    });
    expect(disallowed.sort()).toEqual(["aFutureRuntimeConfigKey", "handOffUnhandledAfterMinutes"].sort());
  });

  it("allows an empty runtimeConfig", () => {
    expect(agentSelfUpdateDisallowedRuntimeConfigKeys({})).toEqual([]);
  });
});

describe("computeChangedConfigFields", () => {
  const existing = {
    name: "Builder",
    role: "engineer",
    title: "Builder",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    metadata: null,
  };

  it("only reports fields the patch actually changes", () => {
    const patch = configPatchFromSnapshot({ ...existing, capabilities: "writes tests" });
    expect(computeChangedConfigFields(existing, patch)).toEqual({ capabilities: "writes tests" });
  });

  it("reports nothing when the patch matches the existing row", () => {
    const patch = configPatchFromSnapshot({ ...existing });
    expect(computeChangedConfigFields(existing, patch)).toEqual({});
  });

  it("does not include icon or personality in the patch when the snapshot predates those columns (DUR-61 legacy guard)", () => {
    // A snapshot row written before icon/personality existed will have neither key.
    // configPatchFromSnapshot must not emit `icon: undefined` or `personality: undefined`,
    // which would NULL-wipe those columns on the first rollback of any pre-existing revision.
    const legacySnapshot = { ...existing };
    const patch = configPatchFromSnapshot(legacySnapshot as Parameters<typeof configPatchFromSnapshot>[0]);
    expect(Object.prototype.hasOwnProperty.call(patch, "icon")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patch, "personality")).toBe(false);
  });

  it("includes icon and personality in the patch when the snapshot has those keys", () => {
    const modernSnapshot = { ...existing, icon: "crown" as const, personality: "Warm." };
    const patch = configPatchFromSnapshot(modernSnapshot as Parameters<typeof configPatchFromSnapshot>[0]);
    expect(patch).toMatchObject({ icon: "crown", personality: "Warm." });
  });

  it("reports reportsTo and budgetMonthlyCents when a rollback snapshot changes them", () => {
    const patch = configPatchFromSnapshot({
      ...existing,
      reportsTo: "peer-agent-id",
      budgetMonthlyCents: 1_000_000,
    });
    expect(computeChangedConfigFields(existing, patch)).toEqual({
      reportsTo: "peer-agent-id",
      budgetMonthlyCents: 1_000_000,
    });
  });
});
