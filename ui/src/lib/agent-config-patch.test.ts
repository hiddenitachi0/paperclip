// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "./agent-config-patch";

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    avatarAssetId: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      env: {
        OPENAI_API_KEY: {
          type: "plain",
          value: "secret",
        },
      },
      promptTemplate: "Work the issue.",
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: {
      canCreateAgents: false,
    },
    metadata: null,
  };
}

function makeOverlay(patch?: Partial<AgentConfigOverlay>): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    heartbeat: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("replaces adapter config and drops env when the last env binding is cleared", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterConfig: {
          env: undefined,
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "claude-sonnet-4-6",
        promptTemplate: "Work the issue.",
      },
      replaceAdapterConfig: true,
    });
  });

  it("writes the cheap profile under runtimeConfig.modelProfiles, never on primary adapterConfig", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "claude-haiku-4-5" },
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
        },
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "claude-haiku-4-5" },
          },
        },
      },
    });
    // The primary adapterConfig is untouched.
    expect(patch.adapterConfig).toBeUndefined();
  });

  it("writes max-turn continuation policy under runtimeConfig.heartbeat", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        heartbeat: {
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      },
    });
  });

  it("merges cheap profile changes onto existing runtimeConfig.modelProfiles state", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      modelProfiles: {
        cheap: {
          enabled: false,
          adapterConfig: { model: "old-cheap" },
        },
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        modelProfiles: {
          cheap: {
            enabled: true,
          },
        },
      }),
    );

    expect((patch.runtimeConfig as Record<string, unknown>).modelProfiles).toEqual({
      cheap: {
        enabled: true,
        adapterConfig: { model: "old-cheap" },
      },
    });
  });

  it("clears the cheap profile when the overlay marks it cleared", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "claude-haiku-4-5" },
        },
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        modelProfiles: { cheap: { cleared: true } },
      }),
    );

    expect(patch.runtimeConfig).toEqual({
      heartbeat: { enabled: true, intervalSec: 300 },
    });
  });

  it("keeps per-agent run time limits across an adapter switch, and drops one when it is cleared", () => {
    const agent = makeAgent();
    agent.adapterConfig = { ...agent.adapterConfig, maxRunDurationMinutes: 30, silentRunTimeoutMinutes: 0 };

    const switched = buildAgentUpdatePatch(agent, makeOverlay({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } }));
    expect(switched.adapterConfig).toMatchObject({ maxRunDurationMinutes: 30, silentRunTimeoutMinutes: 0, model: "gpt-5.4" });

    const cleared = buildAgentUpdatePatch(agent, makeOverlay({ adapterConfig: { maxRunDurationMinutes: undefined } }));
    expect(cleared.replaceAdapterConfig).toBe(true);
    expect(cleared.adapterConfig).not.toHaveProperty("maxRunDurationMinutes");
    expect(cleared.adapterConfig).toMatchObject({ silentRunTimeoutMinutes: 0, model: "claude-sonnet-4-6" });
  });

  it("preserves adapter-agnostic keys when changing adapter types", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      replaceAdapterConfig: true,
    });
  });
});

// DUR-4000: while a persona is attached the persona's backstory fills the
// personality slot, so the agent's own personality text is never sent --
// the same rule the New Agent page applies on hire.
describe("buildAgentUpdatePatch and personas (DUR-4000)", () => {
  const personaId = "11111111-1111-4111-8111-111111111111";

  it("drops personality when the agent already has a persona and the overlay leaves it attached", () => {
    const patch = buildAgentUpdatePatch(
      { ...makeAgent(), personaId },
      makeOverlay({ identity: { personality: "Typed into a hidden field", tone: "Plain." } }),
    );
    expect(patch).toEqual({ tone: "Plain." });
  });

  it("drops personality when the overlay attaches a persona in the same save", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({ identity: { personaId, personality: "Old text" } }),
    );
    expect(patch).toEqual({ personaId });
  });

  it("keeps personality for a blank job, and when the overlay detaches the persona", () => {
    expect(buildAgentUpdatePatch(makeAgent(), makeOverlay({ identity: { personality: "Who this agent is" } }))).toEqual({
      personality: "Who this agent is",
    });
    expect(
      buildAgentUpdatePatch(
        { ...makeAgent(), personaId },
        makeOverlay({ identity: { personaId: null, personality: "Back to its own text" } }),
      ),
    ).toEqual({ personaId: null, personality: "Back to its own text" });
  });
});
