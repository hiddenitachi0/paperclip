import { describe, expect, it } from "vitest";
import {
  CLAUDE_THINKING_EFFORT_LEVELS,
  CODEX_THINKING_EFFORT_LEVELS,
  OPENCODE_THINKING_EFFORT_LEVELS,
  getThinkingEffortKey,
  getThinkingEffortLevels,
  getThinkingEffortOptions,
  isThinkingEffortValid,
  validateAdapterModelEffort,
} from "./model-effort.js";
import { createAgentSchema, createAgentHireSchema, updateAgentSchema } from "./validators/agent.js";
import { createIssueSchema, issueAssigneeAdapterOverridesSchema, updateIssueSchema } from "./validators/issue.js";

describe("thinking effort — one shared level list per adapter", () => {
  it("claude_local uses the `effort` key with low..max", () => {
    expect(getThinkingEffortKey("claude_local")).toBe("effort");
    expect(getThinkingEffortLevels("claude_local")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingEffortLevels("claude_local")).toBe(CLAUDE_THINKING_EFFORT_LEVELS);
  });

  it("codex_local uses `modelReasoningEffort` with minimal..xhigh", () => {
    expect(getThinkingEffortKey("codex_local")).toBe("modelReasoningEffort");
    expect(getThinkingEffortLevels("codex_local")).toBe(CODEX_THINKING_EFFORT_LEVELS);
    expect(CODEX_THINKING_EFFORT_LEVELS).not.toContain("max");
  });

  it("opencode_local uses `variant` with minimal..max", () => {
    expect(getThinkingEffortKey("opencode_local")).toBe("variant");
    expect(getThinkingEffortLevels("opencode_local")).toBe(OPENCODE_THINKING_EFFORT_LEVELS);
  });

  it("acpx_local follows the CLI it wraps", () => {
    expect(getThinkingEffortKey("acpx_local", { agent: "codex" })).toBe("modelReasoningEffort");
    expect(getThinkingEffortLevels("acpx_local", { agent: "codex" })).toBe(CODEX_THINKING_EFFORT_LEVELS);
    expect(getThinkingEffortKey("acpx_local", {})).toBe("effort");
    expect(getThinkingEffortLevels("acpx_local", {})).toBe(CLAUDE_THINKING_EFFORT_LEVELS);
  });

  it("other adapters accept free text (no list to check against)", () => {
    expect(getThinkingEffortKey("pi_local")).toBe("effort");
    expect(getThinkingEffortLevels("pi_local")).toBeNull();
    expect(getThinkingEffortLevels(null)).toBeNull();
    expect(isThinkingEffortValid("pi_local", "whatever-the-cli-takes")).toBe(true);
  });

  it("options start with a configurable auto/default entry and use the level list", () => {
    const options = getThinkingEffortOptions("claude_local", undefined, { autoLabel: "Default" });
    expect(options[0]).toEqual({ id: "", label: "Default" });
    expect(options.slice(1).map((option) => option.id)).toEqual([...CLAUDE_THINKING_EFFORT_LEVELS]);
    expect(getThinkingEffortOptions("codex_local")[0]).toEqual({ id: "", label: "Auto" });
    expect(getThinkingEffortOptions("codex_local").map((option) => option.id)).toEqual(["", ...CODEX_THINKING_EFFORT_LEVELS]);
  });

  it("empty means auto and is always valid", () => {
    expect(isThinkingEffortValid("claude_local", "")).toBe(true);
    expect(isThinkingEffortValid("claude_local", undefined)).toBe(true);
    expect(isThinkingEffortValid("claude_local", "max")).toBe(true);
    expect(isThinkingEffortValid("claude_local", "minimal")).toBe(false);
    expect(isThinkingEffortValid("codex_local", "minimal")).toBe(true);
    expect(isThinkingEffortValid("codex_local", "max")).toBe(false);
  });
});

describe("validateAdapterModelEffort — plain-language typo guard", () => {
  it("accepts a well-formed claude config and cleared fields", () => {
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-1", effort: "max" } })).toBeNull();
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { model: "", effort: "" } })).toBeNull();
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: {} })).toBeNull();
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: undefined })).toBeNull();
  });

  it("rejects a misspelled effort with the valid levels and a suggestion", () => {
    const error = validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { effort: "High " } });
    expect(error).toContain("\"High \" is not a level Claude understands");
    expect(error).toContain("Did you mean \"high\"?");
    expect(error).toContain("low, medium, high, xhigh, max");
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { effort: "hgih" } })).not.toContain("Did you mean");
  });

  it("rejects levels that belong to another adapter", () => {
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { effort: "minimal" } })).toContain("Claude");
    expect(validateAdapterModelEffort({ adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "max" } })).toContain("Codex");
    expect(validateAdapterModelEffort({ adapterType: "opencode_local", adapterConfig: { variant: "turbo" } })).toContain("OpenCode");
  });

  it("only checks the adapter's own effort key", () => {
    // The UI clears every effort key with "" regardless of adapter; a stray key from a
    // previous adapter type must not block saving.
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { effort: "high", modelReasoningEffort: "bogus" } })).toBeNull();
  });

  it("looks up an acpx agent's wrapped CLI from the agent config when checking an override", () => {
    expect(validateAdapterModelEffort({
      adapterType: "acpx_local",
      adapterConfig: { modelReasoningEffort: "minimal" },
      agentAdapterConfig: { agent: "codex" },
    })).toBeNull();
    expect(validateAdapterModelEffort({
      adapterType: "acpx_local",
      adapterConfig: { effort: "minimal" },
      agentAdapterConfig: { agent: "claude" },
    })).toContain("ACP");
  });

  it("never rejects free-text adapters, but still requires text", () => {
    expect(validateAdapterModelEffort({ adapterType: "pi_local", adapterConfig: { effort: "anything" } })).toBeNull();
    expect(validateAdapterModelEffort({ adapterType: "pi_local", adapterConfig: { effort: 3 } })).toContain("written as text");
  });

  it("guards the model field against obvious mistakes", () => {
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { model: 42 } })).toContain("written as text");
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { model: "claude opus" } })).toContain("contains spaces");
    expect(validateAdapterModelEffort({ adapterType: "claude_local", adapterConfig: { model: "x".repeat(201) } })).toContain("too long");
  });
});

describe("agent validators reject model/effort typos", () => {
  const base = { name: "Agent", adapterType: "claude_local" };

  it("createAgentSchema rejects a bad effort with the plain-language message", () => {
    const parsed = createAgentSchema.safeParse({ ...base, adapterConfig: { effort: "hgih" } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["adapterConfig"]);
    expect(parsed.error.issues[0]?.message).toContain("Choose one of: low, medium, high, xhigh, max");
  });

  it("createAgentSchema accepts valid and cleared values", () => {
    expect(createAgentSchema.safeParse({ ...base, adapterConfig: { effort: "xhigh", model: "claude-opus-4-1" } }).success).toBe(true);
    expect(createAgentSchema.safeParse({ ...base, adapterConfig: { effort: "", model: "" } }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: "Codex", adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "minimal" } }).success).toBe(true);
  });

  it("createAgentSchema checks the cheap model profile too", () => {
    const parsed = createAgentSchema.safeParse({
      ...base,
      adapterConfig: { effort: "high" },
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "claude-haiku-4-5", effort: "medium " } } } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain("Cheap model profile:");
    expect(parsed.error.issues[0]?.path).toEqual(["runtimeConfig", "modelProfiles", "cheap", "adapterConfig"]);
  });

  it("createAgentHireSchema carries the same guard", () => {
    expect(createAgentHireSchema.safeParse({ ...base, adapterConfig: { effort: "ultra" } }).success).toBe(false);
    expect(createAgentHireSchema.safeParse({ ...base, adapterConfig: { effort: "max" } }).success).toBe(true);
  });

  it("updateAgentSchema still accepts partial bodies (the PATCH route re-checks with the effective adapter)", () => {
    expect(updateAgentSchema.safeParse({ adapterConfig: { effort: "high" } }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});

describe("task override validator rejects model/effort typos", () => {
  it("rejects a Codex level that does not exist", () => {
    const parsed = issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { modelReasoningEffort: "max" } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["adapterConfig", "modelReasoningEffort"]);
    expect(parsed.error.issues[0]?.message).toContain("minimal, low, medium, high, xhigh");
  });

  it("rejects an OpenCode variant that does not exist", () => {
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { variant: "turbo" } }).success).toBe(false);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { variant: "max" } }).success).toBe(true);
  });

  it("requires model and effort to be text but leaves the Claude-vs-free decision to the route", () => {
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { model: 7 } }).success).toBe(false);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { effort: true } }).success).toBe(false);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { model: "claude-opus-4-1", effort: "max" } }).success).toBe(true);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ modelProfile: "cheap" }).success).toBe(true);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { effort: "hgih" } }).success).toBe(true);
  });

  it("is wired into create and update task bodies", () => {
    expect(createIssueSchema.safeParse({ title: "T", assigneeAdapterOverrides: { adapterConfig: { modelReasoningEffort: "max" } } }).success).toBe(false);
    expect(createIssueSchema.safeParse({ title: "T", assigneeAdapterOverrides: { adapterConfig: { effort: "max" } } }).success).toBe(true);
    expect(createIssueSchema.safeParse({ title: "T", assigneeAdapterOverrides: null }).success).toBe(true);
    expect(updateIssueSchema.safeParse({ assigneeAdapterOverrides: { adapterConfig: { variant: "bogus" } } }).success).toBe(false);
  });
});
