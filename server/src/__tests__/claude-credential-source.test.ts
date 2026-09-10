// DUR-3969/DUR-3970: the Claude sign-in resolution order, and the three
// operator-facing messages that replace the CLI's "Not logged in - Please run
// /login" (which describes the wrong problem and names an action a
// non-technical operator cannot take).
import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTH_SETTINGS_PATH,
  buildClaudeAuthOperatorMessage,
  classifyClaudeCredentialSource,
  claudeAuthFailureIsInstanceWide,
  claudeEnvHasOwnCredential,
  describeClaudeCredentialReadiness,
  processEnvHasClaudeCredential,
} from "../services/claude-credential-source.ts";

const AGENT_TOKEN = "sk-ant-oat01-agents-own";
const INSTANCE_TOKEN = "sk-ant-oat01-instance-wide";
const PROCESS_TOKEN = "sk-ant-oat01-server-process";

describe("Claude credential resolution order", () => {
  it("uses the agent's own binding when it has one, whatever else exists", () => {
    expect(
      classifyClaudeCredentialSource({
        mergedEnvHasOwnCredential: true,
        instanceToken: INSTANCE_TOKEN,
        processEnv: { CLAUDE_CODE_OAUTH_TOKEN: PROCESS_TOKEN },
      }),
    ).toBe("agent");
  });

  it("inherits the instance sign-in when the agent has nothing of its own", () => {
    expect(
      classifyClaudeCredentialSource({
        mergedEnvHasOwnCredential: false,
        instanceToken: INSTANCE_TOKEN,
        processEnv: { CLAUDE_CODE_OAUTH_TOKEN: PROCESS_TOKEN },
      }),
    ).toBe("instance");
  });

  it("falls back to the server process env only when there is no instance sign-in", () => {
    expect(
      classifyClaudeCredentialSource({
        mergedEnvHasOwnCredential: false,
        instanceToken: null,
        processEnv: { CLAUDE_CODE_OAUTH_TOKEN: PROCESS_TOKEN },
      }),
    ).toBe("process_env");
  });

  it("reports nothing at all when no tier supplies a credential", () => {
    expect(
      classifyClaudeCredentialSource({
        mergedEnvHasOwnCredential: false,
        instanceToken: null,
        processEnv: {},
      }),
    ).toBe("none");
  });

  it("treats a blank instance token as no instance sign-in", () => {
    expect(
      classifyClaudeCredentialSource({
        mergedEnvHasOwnCredential: false,
        instanceToken: "   ",
        processEnv: {},
      }),
    ).toBe("none");
  });

  it("recognises every shape of credential the adapter accepts", () => {
    expect(claudeEnvHasOwnCredential({})).toBe(false);
    expect(claudeEnvHasOwnCredential({ CLAUDE_CODE_OAUTH_TOKEN: "   " })).toBe(false);
    expect(claudeEnvHasOwnCredential({ CLAUDE_CODE_OAUTH_TOKEN: AGENT_TOKEN })).toBe(true);
    expect(claudeEnvHasOwnCredential({ ANTHROPIC_API_KEY: "sk-ant-api03-x" })).toBe(true);
    expect(claudeEnvHasOwnCredential({ ANTHROPIC_AUTH_TOKEN: "x" })).toBe(true);
    expect(claudeEnvHasOwnCredential({ CLAUDE_CODE_USE_BEDROCK: "true" })).toBe(true);
    expect(claudeEnvHasOwnCredential({ ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock" })).toBe(true);
    expect(processEnvHasClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN: PROCESS_TOKEN })).toBe(true);
    expect(processEnvHasClaudeCredential({})).toBe(false);
  });
});

describe("who owns the failure", () => {
  it("an agent's own rejected token is an agent fact; every other case is instance-wide", () => {
    expect(claudeAuthFailureIsInstanceWide("agent")).toBe(false);
    expect(claudeAuthFailureIsInstanceWide("instance")).toBe(true);
    expect(claudeAuthFailureIsInstanceWide("process_env")).toBe(true);
    expect(claudeAuthFailureIsInstanceWide("none")).toBe(true);
  });
});

describe("operator-facing messages", () => {
  const messages = {
    agent: buildClaudeAuthOperatorMessage({ source: "agent", agentName: "Reviewer 2" }),
    instance: buildClaudeAuthOperatorMessage({ source: "instance", agentName: "Reviewer 2" }),
    process_env: buildClaudeAuthOperatorMessage({ source: "process_env", agentName: "Reviewer 2" }),
    none: buildClaudeAuthOperatorMessage({ source: "none", agentName: "Reviewer 2" }),
  };

  it("says which of the three cases it is, and they are all different", () => {
    const distinct = new Set(Object.values(messages));
    expect(distinct.size).toBe(4);
    expect(messages.agent).toContain("its own Claude sign-in");
    expect(messages.instance).toContain("The shared Claude sign-in has stopped working");
    expect(messages.none).toContain("There is no Claude sign-in");
    expect(messages.process_env).toContain("set on the server itself");
  });

  it("names where to fix it in every case", () => {
    for (const message of Object.values(messages)) {
      expect(message).toContain(CLAUDE_AUTH_SETTINGS_PATH);
    }
  });

  it("never tells the operator to run /login, and uses no jargon", () => {
    for (const message of Object.values(messages)) {
      expect(message).not.toMatch(/\/login/);
      expect(message).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|secret_ref|adapter_config|subtype=|OAuth/i);
    }
  });

  it("tells the operator that fixing the shared sign-in fixes every agent at once", () => {
    expect(messages.instance).toMatch(/by itself|on its own/);
    expect(messages.instance).toContain("you do not need to fix them one at a time");
  });

  it("names the agent when it knows it, and reads correctly when it does not", () => {
    expect(messages.agent.startsWith("Reviewer 2 has its own")).toBe(true);
    expect(buildClaudeAuthOperatorMessage({ source: "agent" }).startsWith("This agent has its own")).toBe(true);
    expect(buildClaudeAuthOperatorMessage({ source: "instance" })).toContain("so this agent could not start");
    expect(buildClaudeAuthOperatorMessage({ source: "none", agentName: "   " })).toContain(
      "no Claude sign-in for this agent",
    );
  });
});

describe("employment readiness", () => {
  it("a newly employed agent with no wiring of its own is ready as long as something can be inherited", () => {
    expect(describeClaudeCredentialReadiness("instance")).toEqual({ ready: true, message: null });
    expect(describeClaudeCredentialReadiness("process_env")).toEqual({ ready: true, message: null });
    expect(describeClaudeCredentialReadiness("agent")).toEqual({ ready: true, message: null });
  });

  it("only a total absence of any sign-in makes an employed agent unable to run, and says so plainly", () => {
    const readiness = describeClaudeCredentialReadiness("none");
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain(CLAUDE_AUTH_SETTINGS_PATH);
    expect(readiness.message).toContain("nothing to set up on the agent itself");
  });
});
