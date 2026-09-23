import { describe, expect, it } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import {
  dataLine,
  instructionsLine,
  isProviderRefusalMessage,
  modelAndKeyLine,
  readinessBlocksSwitchOn,
  toolsLine,
} from "./quick-agent-readiness";

/**
 * DUR-3997 slice 4: the readiness checklist as data. The rules that must
 * hold: only the model-and-key line can block; it blocks exactly when the
 * agent has nothing Paperclip could call a model with (no model id for a
 * free-form provider, no address for a local model, no key, a key the
 * provider REFUSED); a failed test that was a rate limit, an outage or a
 * vault hiccup is a warning, never a block.
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

const base = {
  providerLabel: "OpenAI",
  model: null,
  bindingSecretId: null,
  boundSecret: null,
  secretsFailed: false,
  instanceKey: null,
  baseUrl: null,
};
const bound = { bindingSecretId: "sec-1" };

describe("isProviderRefusalMessage", () => {
  it("recognises every refusal the server writes, and nothing transient", () => {
    expect(isProviderRefusalMessage("OpenAI did not accept this key (invalid_api_key).")).toBe(true);
    expect(isProviderRefusalMessage("Claude did not accept this key (401 authentication_error).")).toBe(true);
    expect(isProviderRefusalMessage("A key is saved, but Claude did not accept it the last time it was tested.")).toBe(true);
    expect(isProviderRefusalMessage("OpenAI is rate limiting this key right now. The key itself may still be fine.")).toBe(false);
    expect(isProviderRefusalMessage("OpenAI is having trouble right now (HTTP 503). Try again in a minute.")).toBe(false);
    expect(isProviderRefusalMessage("OpenAI did not answer within 10 seconds.")).toBe(false);
    expect(isProviderRefusalMessage("Could not reach OpenAI: ENOTFOUND")).toBe(false);
    expect(isProviderRefusalMessage("Paperclip could not read the stored value to test it: vault down")).toBe(false);
    expect(isProviderRefusalMessage(null)).toBe(false);
  });
});

describe("readinessBlocksSwitchOn", () => {
  it("blocks on blocked, checking and error; never on ok or todo", () => {
    expect(readinessBlocksSwitchOn("blocked")).toBe(true);
    expect(readinessBlocksSwitchOn("checking")).toBe(true);
    expect(readinessBlocksSwitchOn("error")).toBe(true);
    expect(readinessBlocksSwitchOn("ok")).toBe(false);
    expect(readinessBlocksSwitchOn("todo")).toBe(false);
  });
});

describe("modelAndKeyLine", () => {
  it("is green on Claude with no company key: Paperclip's own key is used and the line says so", () => {
    const line = modelAndKeyLine({ ...base, provider: "anthropic", providerLabel: "Claude" });
    expect(line.state).toBe("ok");
    expect(line.text).toContain("Paperclip's own key");
    expect(line.text).toContain("claude-sonnet-5");
  });

  it("stays green on Claude while Paperclip's own key is loading or cannot be seen", () => {
    expect(modelAndKeyLine({ ...base, provider: "anthropic", providerLabel: "Claude", instanceKey: undefined }).state).toBe("ok");
    expect(modelAndKeyLine({ ...base, provider: "anthropic", providerLabel: "Claude", instanceKey: null }).state).toBe("ok");
  });

  it("blocks on Claude when an admin can see that Paperclip has no key of its own", () => {
    const line = modelAndKeyLine({
      ...base,
      provider: "anthropic",
      providerLabel: "Claude",
      instanceKey: { configured: false, lastTestOk: null, lastTestMessage: null },
    });
    expect(line.state).toBe("blocked");
    expect(line.text).toContain("no key of its own");
  });

  it("applies the refusal rule to Paperclip's own key too", () => {
    const refused = modelAndKeyLine({
      ...base,
      provider: "anthropic",
      providerLabel: "Claude",
      instanceKey: { configured: true, lastTestOk: false, lastTestMessage: "Claude did not accept this key (401)." },
    });
    expect(refused.state).toBe("blocked");
    expect(refused.text).toContain("Claude refused Paperclip's own key");
    expect(refused.link?.to).toBe("/company/settings/instance/claude");

    const outage = modelAndKeyLine({
      ...base,
      provider: "anthropic",
      providerLabel: "Claude",
      instanceKey: { configured: true, lastTestOk: false, lastTestMessage: "Claude is having trouble right now (HTTP 529)." },
    });
    expect(outage.state).toBe("todo");
    expect(outage.text).toContain("Its last test failed: Claude is having trouble right now (HTTP 529).");
  });

  it("blocks on OpenAI with no key and points at Connections", () => {
    const line = modelAndKeyLine({ ...base, provider: "openai" });
    expect(line.state).toBe("blocked");
    expect(line.text).toContain("no key yet");
    expect(line.link?.to).toBe("/company/settings/connections");
  });

  it("is green with a bound company key, naming the model and the key and whether it was tested", () => {
    const untested = modelAndKeyLine({ ...base, ...bound, provider: "openai", boundSecret: secret() });
    expect(untested.state).toBe("ok");
    expect(untested.text).toContain("OpenAI · gpt-4.1-mini");
    expect(untested.text).toContain('"OpenAI — all agents"');
    expect(untested.text).toContain("not tested yet");

    const tested = modelAndKeyLine({
      ...base,
      ...bound,
      provider: "openai",
      model: "gpt-4.1",
      boundSecret: secret({ lastTestOk: true, lastTestAt: new Date() }),
    });
    expect(tested.state).toBe("ok");
    expect(tested.text).toContain("OpenAI · gpt-4.1");
    expect(tested.text).toContain("tested and working");
  });

  it("blocks only when the provider REFUSED the bound key; a rate limit or outage is a warning", () => {
    const refused = modelAndKeyLine({
      ...base,
      ...bound,
      provider: "openai",
      boundSecret: secret({ lastTestOk: false, lastTestMessage: "OpenAI did not accept this key (invalid_api_key)." }),
    });
    expect(refused.state).toBe("blocked");
    expect(refused.text).toContain("refused the key");

    const rateLimited = modelAndKeyLine({
      ...base,
      ...bound,
      provider: "openai",
      boundSecret: secret({
        lastTestOk: false,
        lastTestMessage: "OpenAI is rate limiting this key right now. The key itself may still be fine.",
      }),
    });
    expect(rateLimited.state).toBe("todo");
    expect(readinessBlocksSwitchOn(rateLimited.state)).toBe(false);
    expect(rateLimited.text).toContain("Last test failed: OpenAI is rate limiting this key right now.");
    expect(rateLimited.text).toContain("test it again in Connections");

    const vault = modelAndKeyLine({
      ...base,
      ...bound,
      provider: "openai",
      boundSecret: secret({
        lastTestOk: false,
        lastTestMessage: "Paperclip could not read the stored value to test it: vault down",
      }),
    });
    expect(vault.state).toBe("todo");
  });

  it("blocks a bound Claude sign-in token: it is not an API key", () => {
    const line = modelAndKeyLine({
      ...base,
      ...bound,
      provider: "anthropic",
      providerLabel: "Claude",
      boundSecret: secret({ kind: "claude_subscription_token", name: "Claude sign-in" }),
    });
    expect(line.state).toBe("blocked");
    expect(line.text).toContain("Claude sign-in token, not an API key");
    expect(line.text).toContain("Add a Claude API key under Connections");
    expect(line.link?.to).toBe("/company/settings/connections");
  });

  it("blocks when the bound key is disabled or archived (with the right Secrets action), or is gone", () => {
    const disabled = modelAndKeyLine({ ...base, ...bound, provider: "openai", boundSecret: secret({ status: "disabled" }) });
    expect(disabled.state).toBe("blocked");
    expect(disabled.text).toContain("is disabled. Enable it in Secrets");

    const archived = modelAndKeyLine({ ...base, ...bound, provider: "openai", boundSecret: secret({ status: "archived" }) });
    expect(archived.state).toBe("blocked");
    expect(archived.text).toContain("is archived. Unarchive it in Secrets");
    expect(archived.text).not.toContain("Enable it");

    const gone = modelAndKeyLine({ ...base, ...bound, provider: "openai", boundSecret: null });
    expect(gone.state).toBe("blocked");
    expect(gone.text).toContain("no longer exists");
  });

  it("is 'checking' while the secrets list is loading and an explicit error when it failed", () => {
    expect(modelAndKeyLine({ ...base, ...bound, provider: "openai", boundSecret: undefined }).state).toBe("checking");
    const failed = modelAndKeyLine({ ...base, ...bound, provider: "openai", boundSecret: undefined, secretsFailed: true });
    expect(failed.state).toBe("error");
    expect(failed.text).toContain("Could not load the company's keys");
    expect(failed.text).toContain("Reload the page");
    expect(readinessBlocksSwitchOn(failed.state)).toBe(true);
  });

  it("blocks OpenRouter and a local model until a model id is typed (the server refuses the call without one)", () => {
    const openrouter = modelAndKeyLine({ ...base, ...bound, provider: "openrouter", providerLabel: "OpenRouter", boundSecret: secret() });
    expect(openrouter.state).toBe("blocked");
    expect(openrouter.text).toContain("no model picked yet. Type the model id below");
    expect(openrouter.text).toContain("openai/gpt-4.1-mini");

    const withModel = modelAndKeyLine({
      ...base,
      ...bound,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      boundSecret: secret({ kind: "openrouter_api_key" }),
    });
    expect(withModel.state).toBe("ok");
    expect(withModel.text).toContain("OpenRouter · meta-llama/llama-3.3-70b-instruct");

    const localNoModel = modelAndKeyLine({ ...base, provider: "local", providerLabel: "Local model", baseUrl: "http://localhost:11434/v1" });
    expect(localNoModel.state).toBe("blocked");
    expect(localNoModel.text).toContain("llama3.1");
  });

  it("needs a model address for a local model, but no key", () => {
    expect(modelAndKeyLine({ ...base, provider: "local", providerLabel: "Local model", model: "llama3.1" }).state).toBe("blocked");
    const ready = modelAndKeyLine({
      ...base,
      provider: "local",
      providerLabel: "Local model",
      model: "llama3.1",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(ready.state).toBe("ok");
    expect(ready.text).toContain("Local model llama3.1 at http://localhost:11434/v1 · no key needed");
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
