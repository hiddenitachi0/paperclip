import { describe, expect, it } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { dataLine, instructionsLine, modelAndKeyLine, toolsLine } from "./quick-agent-readiness";

/**
 * DUR-3997 slice 4: the readiness checklist as data. The one rule that must
 * hold: only the model-and-key line can block, and it blocks exactly when the
 * agent has nothing Paperclip could call a model with.
 */

function secret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "sec-1",
    companyId: "co-1",
    key: "openai_api_key__all_agents",
    name: "OpenAI — all agents",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    kind: "openai_api_key",
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-09-20T00:00:00Z"),
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

const base = { providerLabel: "OpenAI", bindingSecretId: null, boundSecret: null, instanceKeyConfigured: null, baseUrl: null };

describe("modelAndKeyLine", () => {
  it("is green on Claude with no company key: Paperclip's own key is used and the line says so", () => {
    const line = modelAndKeyLine({ ...base, provider: "anthropic", providerLabel: "Claude" });
    expect(line.state).toBe("ok");
    expect(line.text).toContain("Paperclip's own key");
  });

  it("blocks on Claude when an admin can see that Paperclip has no key of its own", () => {
    const line = modelAndKeyLine({ ...base, provider: "anthropic", providerLabel: "Claude", instanceKeyConfigured: false });
    expect(line.state).toBe("blocked");
    expect(line.text).toContain("no key of its own");
  });

  it("blocks on OpenAI with no key and points at Connections", () => {
    const line = modelAndKeyLine({ ...base, provider: "openai" });
    expect(line.state).toBe("blocked");
    expect(line.text).toContain("no key yet");
    expect(line.link?.to).toBe("/company/settings/connections");
  });

  it("is green with a bound company key and names it, saying whether it was tested", () => {
    const untested = modelAndKeyLine({ ...base, provider: "openai", bindingSecretId: "sec-1", boundSecret: secret() });
    expect(untested.state).toBe("ok");
    expect(untested.text).toContain('"OpenAI — all agents"');
    expect(untested.text).toContain("not tested yet");

    const tested = modelAndKeyLine({
      ...base,
      provider: "openai",
      bindingSecretId: "sec-1",
      boundSecret: secret({ lastTestOk: true, lastTestAt: new Date() }),
    });
    expect(tested.state).toBe("ok");
    expect(tested.text).toContain("tested and working");
  });

  it("blocks when the provider refused the bound key at its last test", () => {
    const line = modelAndKeyLine({
      ...base,
      provider: "openai",
      bindingSecretId: "sec-1",
      boundSecret: secret({ lastTestOk: false, lastTestAt: new Date() }),
    });
    expect(line.state).toBe("blocked");
    expect(line.text).toContain("refused the key");
  });

  it("blocks when the bound key is disabled, or is gone", () => {
    const disabled = modelAndKeyLine({
      ...base,
      provider: "openai",
      bindingSecretId: "sec-1",
      boundSecret: secret({ status: "disabled" }),
    });
    expect(disabled.state).toBe("blocked");
    expect(disabled.text).toContain("is disabled");

    const gone = modelAndKeyLine({ ...base, provider: "openai", bindingSecretId: "sec-1", boundSecret: null });
    expect(gone.state).toBe("blocked");
    expect(gone.text).toContain("no longer exists");
  });

  it("is 'checking' while the secrets list is still loading, never a false blocker", () => {
    const line = modelAndKeyLine({ ...base, provider: "openai", bindingSecretId: "sec-1", boundSecret: undefined });
    expect(line.state).toBe("checking");
  });

  it("needs a model address for a local model, but no key", () => {
    expect(modelAndKeyLine({ ...base, provider: "local", providerLabel: "Local model" }).state).toBe("blocked");
    const ready = modelAndKeyLine({
      ...base,
      provider: "local",
      providerLabel: "Local model",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(ready.state).toBe("ok");
    expect(ready.text).toContain("no key needed");
  });
});

describe("toolsLine, dataLine, instructionsLine never block", () => {
  it("tools: counts the ticked tools and links to the Tools tab", () => {
    expect(toolsLine({ enabledCount: 0, failed: false, toolsTabPath: "/agents/x/tools" })).toMatchObject({
      state: "todo",
      link: { to: "/agents/x/tools" },
    });
    expect(toolsLine({ enabledCount: 1, failed: false, toolsTabPath: "/agents/x/tools" }).text).toBe("1 tool ticked.");
    expect(toolsLine({ enabledCount: 3, failed: false, toolsTabPath: "/agents/x/tools" }).text).toBe("3 tools ticked.");
    expect(toolsLine({ enabledCount: undefined, failed: true, toolsTabPath: "/agents/x/tools" }).state).toBe("todo");
  });

  it("data: says the feature is off, that only the owner can see it, or whether sales is connected", () => {
    expect(dataLine({ kind: "feature_off" }).text).toContain("switched off");
    expect(dataLine({ kind: "forbidden" }).text).toContain("Only the company owner");
    expect(dataLine({ kind: "loaded", hasSales: true })).toMatchObject({ state: "ok" });
    expect(dataLine({ kind: "loaded", hasSales: true }).text).toContain("per company");
    expect(dataLine({ kind: "loaded", hasSales: false })).toMatchObject({ state: "todo" });
  });

  it("instructions: set or not", () => {
    expect(instructionsLine("You are the front desk.").state).toBe("ok");
    expect(instructionsLine("   ").state).toBe("todo");
    expect(instructionsLine(null).state).toBe("todo");
  });
});
