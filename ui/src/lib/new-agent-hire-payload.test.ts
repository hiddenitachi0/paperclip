// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildNewAgentHirePayload } from "./new-agent-hire-payload";
import { defaultCreateValues } from "../components/agent-config-defaults";

describe("buildNewAgentHirePayload", () => {
  it("persists the selected default environment id", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Linux Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
          defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
        },
        adapterConfig: { foo: "bar" },
        budgetMonthlyCents: 5000,
      }),
    ).toMatchObject({
      name: "Linux Claude",
      role: "general",
      adapterType: "claude_local",
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 5000,
    });
  });

  it("sends null when no default environment is selected", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Local Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
        },
        adapterConfig: {},
        budgetMonthlyCents: 5000,
      }),
    ).toMatchObject({
      defaultEnvironmentId: null,
    });
  });

  // DUR-3971: the working-style choice made while employing someone.
  it("sends nothing extra when the operator leaves the working style alone", () => {
    const payload = buildNewAgentHirePayload({
      name: "Analyst",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "claude_local" },
      adapterConfig: {},
      budgetMonthlyCents: 5000,
    });

    // The key must be absent, not false: a hire made without touching the
    // choice has to be exactly the hire we sent before the choice existed.
    expect(Object.hasOwn(payload, "laneAEnabled")).toBe(false);
  });

  it("asks for a quick agent when the operator picks 'answers straight away in chat'", () => {
    const payload = buildNewAgentHirePayload({
      name: "Front desk",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "claude_local" },
      adapterConfig: {},
      budgetMonthlyCents: 5000,
      answersStraightAwayInChat: true,
    });

    expect(payload).toMatchObject({ laneAEnabled: true });
  });

  it("sends nothing extra when the operator picks 'goes away and works on tasks'", () => {
    const payload = buildNewAgentHirePayload({
      name: "Analyst",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "claude_local" },
      adapterConfig: {},
      budgetMonthlyCents: 5000,
      answersStraightAwayInChat: false,
    });

    expect(Object.hasOwn(payload, "laneAEnabled")).toBe(false);
  });

  it("changes nothing else about the payload when the quick lane is picked", () => {
    const common = {
      name: "Front desk",
      effectiveRole: "general" as const,
      configValues: { ...defaultCreateValues, adapterType: "claude_local" as const },
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 5000,
    };
    const plain = buildNewAgentHirePayload(common);
    const quick = buildNewAgentHirePayload({ ...common, answersStraightAwayInChat: true });
    const { laneAEnabled, ...quickWithoutChoice } = quick as Record<string, unknown>;

    expect(laneAEnabled).toBe(true);
    expect(quickWithoutChoice).toEqual(plain);
  });

  it("includes core trust preset permissions when provided", () => {
    expect(
      buildNewAgentHirePayload({
        name: "PR Reviewer",
        effectiveRole: "engineer",
        configValues: {
          ...defaultCreateValues,
          adapterType: "codex_local",
        },
        adapterConfig: {},
        budgetMonthlyCents: 5000,
        permissions: {
          canCreateAgents: false,
          trustPreset: "low_trust_review",
          authorizationPolicy: {
            trustPreset: "low_trust_review",
            reviewPreset: {
              id: "low_trust_review",
              version: 1,
              rawOutputDisposition: "quarantine",
            },
            trustBoundary: {
              mode: "low_trust_review",
              companyId: "company-1",
              rootIssueId: "issue-root",
            },
          },
        },
      }),
    ).toMatchObject({
      permissions: {
        canCreateAgents: false,
        trustPreset: "low_trust_review",
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          reviewPreset: {
            id: "low_trust_review",
            version: 1,
            rawOutputDisposition: "quarantine",
          },
          trustBoundary: {
            mode: "low_trust_review",
            companyId: "company-1",
            rootIssueId: "issue-root",
          },
        },
      },
    });
  });

  // DUR-3976: the monthly spending limit chosen on the form.
  it("sends the monthly spending limit the operator chose, in cents", () => {
    const payload = buildNewAgentHirePayload({
      name: "Analyst",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "claude_local" },
      adapterConfig: {},
      budgetMonthlyCents: 12_550,
    });

    expect(payload.budgetMonthlyCents).toBe(12_550);
  });

  it("sends 0 only when the operator chose no limit", () => {
    const payload = buildNewAgentHirePayload({
      name: "Analyst",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "claude_local" },
      adapterConfig: {},
      budgetMonthlyCents: 0,
    });

    expect(payload.budgetMonthlyCents).toBe(0);
  });
});

// DUR-4000: a persona is a person; an agent is a job.
describe("buildNewAgentHirePayload persona and limits (DUR-4000)", () => {
  const base = {
    name: "Sales agent 1",
    effectiveRole: "general",
    configValues: { ...defaultCreateValues, adapterType: "claude_local" },
    adapterConfig: {},
    budgetMonthlyCents: 5000,
  };

  it("sends personaId when a persona is picked and drops the personality text so nothing is said twice", () => {
    const payload = buildNewAgentHirePayload({
      ...base,
      personaId: "11111111-1111-4111-8111-111111111111",
      personality: "Typed before picking the persona",
    });
    expect(payload).toMatchObject({ personaId: "11111111-1111-4111-8111-111111111111" });
    expect(Object.hasOwn(payload, "personality")).toBe(false);
  });

  it("sends nothing extra for a blank job", () => {
    const payload = buildNewAgentHirePayload({ ...base, personaId: null, limits: {} });
    expect(Object.hasOwn(payload, "personaId")).toBe(false);
    expect(Object.hasOwn(payload, "limits")).toBe(false);
  });

  it("sends the limits box only when at least one limit is set", () => {
    expect(
      buildNewAgentHirePayload({ ...base, limits: { dailyImageGenerations: null, dailyPosts: null, notes: "  " } }),
    ).not.toHaveProperty("limits");
    expect(buildNewAgentHirePayload({ ...base, limits: { dailyImageGenerations: 4 } })).toMatchObject({
      limits: { dailyImageGenerations: 4 },
    });
    expect(buildNewAgentHirePayload({ ...base, limits: { notes: "Do not repeat mistakes you made before." } })).toMatchObject({
      limits: { notes: "Do not repeat mistakes you made before." },
    });
  });
});
