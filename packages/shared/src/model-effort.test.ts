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
  agentDefaultLabel,
  deriveChildModelEffortInheritance,
  getThinkingEffortValue,
  validateModelAgainstList,
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

describe("Agent default labels and reading effort back", () => {
  it("labels the no-override choice with the agent's own value", () => {
    expect(agentDefaultLabel("claude-sonnet-5")).toBe("Agent default (claude-sonnet-5)");
    expect(agentDefaultLabel("")).toBe("Agent default");
    expect(agentDefaultLabel(null)).toBe("Agent default");
    const options = getThinkingEffortOptions("claude_local", undefined, { autoLabel: agentDefaultLabel("High") });
    expect(options[0]).toEqual({ id: "", label: "Agent default (High)" });
  });

  it("reads the effort from the key each adapter uses", () => {
    expect(getThinkingEffortValue("claude_local", { effort: "max" })).toBe("max");
    expect(getThinkingEffortValue("codex_local", { modelReasoningEffort: "minimal" })).toBe("minimal");
    expect(getThinkingEffortValue("codex_local", { reasoningEffort: "high" })).toBe("high");
    expect(getThinkingEffortValue("opencode_local", { variant: "xhigh" })).toBe("xhigh");
    expect(getThinkingEffortValue("acpx_local", { agent: "codex", modelReasoningEffort: "low" })).toBe("low");
    expect(getThinkingEffortValue("claude_local", null)).toBe("");
  });
});

describe("model typo guard against the adapter's model list", () => {
  const claudeModels = [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }];

  it("accepts listed models, Claude short names, context suffixes and the agent's own models", () => {
    expect(validateModelAgainstList({ adapterType: "claude_local", model: "claude-opus-5", models: claudeModels })).toBeNull();
    expect(validateModelAgainstList({ adapterType: "claude_local", model: "opus", models: claudeModels })).toBeNull();
    expect(validateModelAgainstList({ adapterType: "claude_local", model: "claude-opus-5[1m]", models: claudeModels })).toBeNull();
    expect(
      validateModelAgainstList({
        adapterType: "claude_local",
        model: "claude-sonnet-4-5",
        models: claudeModels,
        alsoAllowed: ["claude-sonnet-4-5"],
      }),
    ).toBeNull();
    expect(validateModelAgainstList({ adapterType: "claude_local", model: "", models: claudeModels })).toBeNull();
  });

  it("accepts anything when the adapter's list is unknown (empty)", () => {
    expect(validateModelAgainstList({ adapterType: "pi_local", model: "whatever-model", models: [] })).toBeNull();
  });

  it("rejects a typo with a plain message and a suggestion", () => {
    const error = validateModelAgainstList({ adapterType: "claude_local", model: "claude-opus-55", models: claudeModels });
    expect(error).toBe('Model "claude-opus-55" is not one Claude offers. Did you mean "claude-opus-5"?');
    expect(
      validateModelAgainstList({ adapterType: "claude_local", model: "Claude-Sonnet-5", models: claudeModels }),
    ).toContain('Did you mean "claude-sonnet-5"?');
    expect(validateModelAgainstList({ adapterType: "codex_local", model: "opus", models: [{ id: "gpt-5-codex" }] }))
      .toBe('Model "opus" is not one Codex offers. Pick a model from the list.');
  });
});

describe("sub-task flow-down of the parent's model/effort", () => {
  const parentIssue = { issueId: "11111111-1111-4111-8111-111111111111", identifier: "PAP-1" };
  const parentOverrides = { adapterConfig: { model: "claude-opus-5", effort: "max", chrome: true }, useProjectWorkspace: true };

  it("inherits model and effort (only those) when the child sets nothing", () => {
    const result = deriveChildModelEffortInheritance({
      parentOverrides,
      parentAdapterType: "claude_local",
      childAdapterType: "claude_local",
      childOverrides: undefined,
      parentIssue,
    });
    expect(result?.overrides).toEqual({
      adapterConfig: { model: "claude-opus-5", effort: "max" },
      inheritedFrom: { issueId: parentIssue.issueId, identifier: "PAP-1" },
    });
    expect(result?.inherited).toEqual({ model: "claude-opus-5", effort: "max" });
    expect(result?.skipped).toEqual([]);
  });

  it("lets explicit child settings win key by key", () => {
    const result = deriveChildModelEffortInheritance({
      parentOverrides,
      parentAdapterType: "claude_local",
      childAdapterType: "claude_local",
      childOverrides: { adapterConfig: { effort: "low" }, planFirstOnOpus: true },
      parentIssue,
    });
    expect(result?.overrides).toEqual({
      planFirstOnOpus: true,
      adapterConfig: { effort: "low", model: "claude-opus-5" },
      inheritedFrom: { issueId: parentIssue.issueId, identifier: "PAP-1" },
    });
    expect(result?.inherited).toEqual({ model: "claude-opus-5" });
  });

  it("inherits nothing for an explicit null, a model-lane preset, or a fully explicit child", () => {
    const base = { parentOverrides, parentAdapterType: "claude_local", childAdapterType: "claude_local", parentIssue };
    expect(deriveChildModelEffortInheritance({ ...base, childOverrides: null })).toBeNull();
    expect(deriveChildModelEffortInheritance({ ...base, childOverrides: { modelProfile: "cheap" } })).toBeNull();
    expect(
      deriveChildModelEffortInheritance({
        ...base,
        childOverrides: { adapterConfig: { model: "claude-sonnet-5", effort: "low" } },
      }),
    ).toBeNull();
  });

  it("returns null when the parent has no model/effort of its own", () => {
    expect(
      deriveChildModelEffortInheritance({
        parentOverrides: { modelProfile: "cheap" },
        parentAdapterType: "claude_local",
        childAdapterType: "claude_local",
        childOverrides: undefined,
        parentIssue,
      }),
    ).toBeNull();
  });

  it("never hands a Claude model to a Codex agent, but carries over an effort level Codex understands", () => {
    const result = deriveChildModelEffortInheritance({
      parentOverrides: { adapterConfig: { model: "claude-opus-5", effort: "high" } },
      parentAdapterType: "claude_local",
      childAdapterType: "codex_local",
      childOverrides: undefined,
      parentIssue,
    });
    expect(result?.overrides.adapterConfig).toEqual({ modelReasoningEffort: "high" });
    expect(result?.inherited).toEqual({ effort: "high" });
    expect(result?.skipped.map((entry) => entry.key)).toEqual(["model"]);
  });

  it("skips an effort level the child's agent does not have", () => {
    const result = deriveChildModelEffortInheritance({
      parentOverrides: { adapterConfig: { model: "claude-opus-5", effort: "max" } },
      parentAdapterType: "claude_local",
      childAdapterType: "codex_local",
      childOverrides: undefined,
      parentIssue,
    });
    expect(result?.inherited).toEqual({});
    expect(result?.skipped.map((entry) => entry.key).sort()).toEqual(["effort", "model"]);
    expect(result?.skipped.find((entry) => entry.key === "effort")?.reason).toBe('Codex has no "max" thinking level');
  });

  it("keeps the parent's effort key when the child has no agent yet", () => {
    const result = deriveChildModelEffortInheritance({
      parentOverrides: { adapterConfig: { modelReasoningEffort: "minimal" } },
      parentAdapterType: "codex_local",
      childAdapterType: null,
      childOverrides: undefined,
      parentIssue: { issueId: parentIssue.issueId, identifier: null },
    });
    expect(result?.overrides).toEqual({
      adapterConfig: { modelReasoningEffort: "minimal" },
      inheritedFrom: { issueId: parentIssue.issueId },
    });
  });

  it("the task schema accepts the stored inherited-from marker", () => {
    expect(
      issueAssigneeAdapterOverridesSchema.safeParse({
        adapterConfig: { effort: "max" },
        inheritedFrom: { issueId: parentIssue.issueId, identifier: "PAP-1" },
      }).success,
    ).toBe(true);
    expect(
      issueAssigneeAdapterOverridesSchema.safeParse({ inheritedFrom: { issueId: "not-a-uuid" } }).success,
    ).toBe(false);
  });
});
