import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  buildEscalationGrantAdapterConfig,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
} from "../services/heartbeat.ts";

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
