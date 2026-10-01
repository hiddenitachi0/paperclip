import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  buildEscalationGrantAdapterConfig,
  buildResolvedAdapterConfigRunMetadata,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  parseIssueAssigneeAdapterOverrides,
  resolveEffectiveIssueModelProfile,
  resolveModelProfileApplication,
} from "../services/heartbeat.ts";

const plannerProfile: AdapterModelProfileDefinition = {
  key: "planner",
  label: "Planner",
  adapterConfig: {
    model: "claude-opus-5",
    effort: "high",
  },
  source: "adapter_default",
};

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("uses the Codex local adapter cheap default when the agent has no runtime override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {
        model: "gpt-5.3-codex-spark",
        modelReasoningEffort: "high",
      },
    });
  });

  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it("resolves the planner profile's adapter defaults for an adapter that supports it", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile, plannerProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "planner",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "planner",
      requestedBy: "issue_override",
      applied: "planner",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: { model: "claude-opus-5", effort: "high" },
    });
  });
});

// DUR-4144: New Task switch "Plan first on Opus, then build on Sonnet". The
// first run of a job with this switch on must use the planner profile; once
// its plan is accepted (server/src/routes/issues.ts clears the flag), later
// runs must fall back to whatever modelProfile the issue/agent would
// otherwise use.
describe("DUR-4144 plan-first-on-Opus issue switch", () => {
  it("parses planFirstOnOpus off a raw assigneeAdapterOverrides value", () => {
    expect(parseIssueAssigneeAdapterOverrides({ planFirstOnOpus: true })).toEqual({
      modelProfile: null,
      adapterConfig: null,
      useProjectWorkspace: null,
      planFirstOnOpus: true,
    });
  });

  it("treats a missing/false planFirstOnOpus as off and returns null for an otherwise-empty override", () => {
    expect(parseIssueAssigneeAdapterOverrides({})).toBeNull();
    expect(parseIssueAssigneeAdapterOverrides({ planFirstOnOpus: false })).toBeNull();
  });

  it("forces the planner profile while the switch is on, regardless of any explicit modelProfile", () => {
    expect(
      resolveEffectiveIssueModelProfile({ modelProfile: "cheap", planFirstOnOpus: true }),
    ).toBe("planner");
    expect(
      resolveEffectiveIssueModelProfile({ modelProfile: null, planFirstOnOpus: true }),
    ).toBe("planner");
  });

  it("falls back to the issue's explicit modelProfile once the switch is off", () => {
    expect(
      resolveEffectiveIssueModelProfile({ modelProfile: "cheap", planFirstOnOpus: false }),
    ).toBe("cheap");
    expect(resolveEffectiveIssueModelProfile({ modelProfile: null, planFirstOnOpus: false })).toBeNull();
    expect(resolveEffectiveIssueModelProfile(null)).toBeNull();
  });
});

describe("DUR-31 escalation grant dispatch precedence", () => {
  const noProfile = resolveModelProfileApplication({
    adapterModelProfiles: [],
    agentRuntimeConfig: {},
    issueModelProfile: null,
    contextSnapshot: {},
  });

  it("maps a granted model/effort into the claude_local adapterConfig shape", () => {
    expect(
      buildEscalationGrantAdapterConfig("claude_local", {
        grantedModel: "opus", grantedEffort: "high",
      }),
    ).toEqual({ model: "opus", effort: "high" });
  });

  it("maps effort onto modelReasoningEffort for codex_local and variant for opencode_local", () => {
    expect(
      buildEscalationGrantAdapterConfig("codex_local", { grantedModel: null, grantedEffort: "high" }),
    ).toEqual({ modelReasoningEffort: "high" });
    expect(
      buildEscalationGrantAdapterConfig("opencode_local", { grantedModel: null, grantedEffort: "high" }),
    ).toEqual({ variant: "high" });
  });

  it("lets an active grant beat the agent base config and the model profile", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "base-model", effort: "low" },
      modelProfile: noProfile,
      grantAdapterConfig: buildEscalationGrantAdapterConfig("claude_local", {
        grantedModel: "opus", grantedEffort: "high",
      }),
      issueAdapterConfig: null,
    });

    expect(merged).toEqual({ model: "opus", effort: "high" });
  });

  it("lets an explicit operator issue override beat an active grant field-by-field", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "base-model", effort: "low" },
      modelProfile: noProfile,
      grantAdapterConfig: buildEscalationGrantAdapterConfig("claude_local", {
        grantedModel: "opus", grantedEffort: "high",
      }),
      // Operator pinned the model but left effort unset -- the grant's effort
      // still applies since the operator override never touched it.
      issueAdapterConfig: { model: "operator-pinned-model" },
    });

    expect(merged).toEqual({ model: "operator-pinned-model", effort: "high" });
  });

  it("orders base < model profile < grant < issue override end to end", () => {
    const cheapProfileApplication = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "base-model", modelReasoningEffort: "medium", approvalPolicy: "strict" },
      modelProfile: cheapProfileApplication,
      grantAdapterConfig: { model: "grant-model" },
      issueAdapterConfig: { modelReasoningEffort: "explicit-override" },
    });

    expect(merged).toEqual({
      model: "grant-model",
      modelReasoningEffort: "explicit-override",
      approvalPolicy: "strict",
    });
  });
});

// DUR-50: a requested model/effort override can be silently dropped anywhere
// in the resolution chain (e.g. a child issue that never inherited it). This
// records what was actually handed to adapter.execute(), so the operator can
// see what ran instead of just what was requested.
describe("DUR-50 resolved adapter config run metadata", () => {
  it("reads the adapter-specific effort key for the given adapter type", () => {
    expect(
      buildResolvedAdapterConfigRunMetadata({
        adapterType: "claude_local",
        runtimeConfig: { model: "opus", effort: "max" },
      }),
    ).toEqual({ model: "opus", effort: "max" });

    expect(
      buildResolvedAdapterConfigRunMetadata({
        adapterType: "codex_local",
        runtimeConfig: { model: "gpt-5", modelReasoningEffort: "high" },
      }),
    ).toEqual({ model: "gpt-5", effort: "high" });

    expect(
      buildResolvedAdapterConfigRunMetadata({
        adapterType: "opencode_local",
        runtimeConfig: { model: "sonnet", variant: "thinking" },
      }),
    ).toEqual({ model: "sonnet", effort: "thinking" });
  });

  it("returns null when the runtime config carries neither a model nor an effort value", () => {
    expect(
      buildResolvedAdapterConfigRunMetadata({
        adapterType: "claude_local",
        runtimeConfig: { approvalPolicy: "strict" },
      }),
    ).toBeNull();
  });

  it("omits effort for an adapter type with no known effort key", () => {
    expect(
      buildResolvedAdapterConfigRunMetadata({
        adapterType: "unknown_adapter",
        runtimeConfig: { model: "some-model", effort: "max" },
      }),
    ).toEqual({ model: "some-model" });
  });
});
