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
      }),
    ).toMatchObject({
      name: "Linux Claude",
      role: "general",
      adapterType: "claude_local",
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 0,
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
});
