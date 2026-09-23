import { resolveLaneAModelForProvider, type CompanySecret, type LaneAProvider } from "@paperclipai/shared";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "./instance-settings";

/**
 * DUR-3997: the quick-agent readiness checklist, as plain data.
 *
 * Four lines. Each is green ("ok"), a gentle to-do ("todo": the agent works
 * without it, or something is worth a look), a blocker ("blocked": the agent
 * cannot be switched on), still loading ("checking"), or could not be
 * checked at all ("error"). Only the model-and-key line can block; tools,
 * data and instructions are optional by design. The wording is what the
 * operator reads, so every text says what to do next, never just what is
 * wrong.
 *
 * Pure functions so the states can be tested without rendering anything.
 */
export type ReadinessState = "ok" | "todo" | "blocked" | "checking" | "error";

export interface ReadinessLine {
  id: "model" | "tools" | "data" | "instructions";
  label: string;
  state: ReadinessState;
  text: string;
  /** Where to go to fix it, if anywhere. */
  link?: { to: string; label: string };
}

export const CONNECTIONS_PATH = "/company/settings/connections";
const SECRETS_PATH = "/company/settings/secrets";
const CLAUDE_SIGN_IN_PATH = `${INSTANCE_SETTINGS_PATH_PREFIX}/claude`;

/** True when the switch must stay off: nothing usable, or nothing known yet. */
export function readinessBlocksSwitchOn(state: ReadinessState): boolean {
  return state === "blocked" || state === "checking" || state === "error";
}

/**
 * The server records `lastTestOk: false` for a refused key AND for a rate
 * limit, a provider outage, a DNS failure, a timeout, or a vault that could
 * not be read (server/src/services/secret-kind-probes.ts, secret-tests.ts,
 * server-anthropic-key.ts). Only a refusal means the key itself is wrong.
 * Every refusal message the server writes says "did not accept"; the others
 * say "rate limiting", "having trouble", "did not answer", "could not read".
 */
export function isProviderRefusalMessage(message: string | null | undefined): boolean {
  return /did not accept|refused/i.test(message ?? "");
}

const FREE_FORM_MODEL_EXAMPLE: Partial<Record<LaneAProvider, string>> = {
  openrouter: "openai/gpt-4.1-mini",
  local: "llama3.1",
};

export interface InstanceKeyStatusForReadiness {
  configured: boolean;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

export function modelAndKeyLine(input: {
  provider: LaneAProvider;
  providerLabel: string;
  /** The model id on the agent, or null for the provider default. */
  model: string | null;
  /** The secret_ref bound at adapterConfig.laneA.apiKey, if any. */
  bindingSecretId: string | null;
  /** The bound secret once the company's list has loaded; undefined while loading. */
  boundSecret: CompanySecret | null | undefined;
  /** True when the company's secrets list could not be loaded at all. */
  secretsFailed: boolean;
  /** Paperclip's own key: null when the viewer may not see it, undefined while loading. */
  instanceKey: InstanceKeyStatusForReadiness | null | undefined;
  /** For local models: the model address on the agent. */
  baseUrl: string | null;
}): ReadinessLine {
  const base = { id: "model" as const, label: "Model and key" };
  const connections = { to: CONNECTIONS_PATH, label: "Open Connections" };
  const label = input.providerLabel;

  // The model first: for OpenRouter and a local model there is no default,
  // and the server refuses the call (LANE_A_MODEL_MISSING) until one is typed.
  const model = resolveLaneAModelForProvider(input.provider, input.model);
  if (!model) {
    const example = FREE_FORM_MODEL_EXAMPLE[input.provider] ?? "the model id";
    return {
      ...base,
      state: "blocked",
      text: `${label} · no model picked yet. Type the model id below (for example ${example}).`,
    };
  }
  if (input.provider === "local" && (!input.baseUrl || input.baseUrl.trim() === "")) {
    return {
      ...base,
      state: "blocked",
      text: `Local model ${model} · enter the model address below first (for example http://localhost:11434/v1).`,
    };
  }

  if (input.bindingSecretId) {
    if (input.secretsFailed) {
      return {
        ...base,
        state: "error",
        text: "Could not load the company's keys, so this agent's key cannot be checked. Reload the page to try again.",
      };
    }
    if (input.boundSecret === undefined) {
      return { ...base, state: "checking", text: "Checking the key…" };
    }
    if (input.boundSecret === null) {
      return {
        ...base,
        state: "blocked",
        text: "The saved key no longer exists. Pick another key below, or add one in Connections.",
        link: connections,
      };
    }
    const secret = input.boundSecret;
    if (secret.kind === "claude_subscription_token") {
      return {
        ...base,
        state: "blocked",
        text: `This is a Claude sign-in token, not an API key, so a quick agent cannot use it. Add a Claude API key under Connections.`,
        link: connections,
      };
    }
    if (secret.status === "archived") {
      return {
        ...base,
        state: "blocked",
        text: `The key "${secret.name}" is archived. Unarchive it in Secrets, or pick another key below.`,
        link: { to: SECRETS_PATH, label: "Open Secrets" },
      };
    }
    if (secret.status !== "active") {
      return {
        ...base,
        state: "blocked",
        text: `The key "${secret.name}" is ${secret.status}. Enable it in Secrets, or pick another key below.`,
        link: { to: SECRETS_PATH, label: "Open Secrets" },
      };
    }
    const using = `${label} · ${model} · the company's key "${secret.name}"`;
    if (secret.lastTestOk === false) {
      if (isProviderRefusalMessage(secret.lastTestMessage)) {
        return {
          ...base,
          state: "blocked",
          text: `${label} refused the key "${secret.name}" when it was last tested. Test it again in Connections, or pick another key below.`,
          link: connections,
        };
      }
      return {
        ...base,
        state: "todo",
        text: `${using}. Last test failed: ${secret.lastTestMessage ?? "no details"} — test it again in Connections.`,
        link: connections,
      };
    }
    const tested = secret.lastTestOk === true ? "tested and working" : "not tested yet";
    return { ...base, state: "ok", text: `${using} (${tested}).` };
  }

  if (input.provider === "anthropic") {
    const using = `Claude · ${model} · Paperclip's own key`;
    const key = input.instanceKey;
    if (key && !key.configured) {
      return {
        ...base,
        state: "blocked",
        text: "Claude · Paperclip has no key of its own yet. Add a company key below, or add Paperclip's own key under Claude sign-in.",
        link: { to: CLAUDE_SIGN_IN_PATH, label: "Open Claude sign-in" },
      };
    }
    if (key && key.lastTestOk === false) {
      if (isProviderRefusalMessage(key.lastTestMessage)) {
        return {
          ...base,
          state: "blocked",
          text: "Claude refused Paperclip's own key when it was last tested. Test it again under Claude sign-in, or add a company key below.",
          link: { to: CLAUDE_SIGN_IN_PATH, label: "Open Claude sign-in" },
        };
      }
      return {
        ...base,
        state: "todo",
        text: `${using}. Its last test failed: ${key.lastTestMessage ?? "no details"} — test it again under Claude sign-in.`,
        link: { to: CLAUDE_SIGN_IN_PATH, label: "Open Claude sign-in" },
      };
    }
    return {
      ...base,
      state: "ok",
      text: `${using}. Add a company key below to use your own instead.`,
    };
  }

  if (input.provider === "local") {
    return {
      ...base,
      state: "ok",
      text: `Local model ${model} at ${input.baseUrl!.trim()} · no key needed.`,
    };
  }

  return {
    ...base,
    state: "blocked",
    text: `${label} · no key yet. Pick one below, or add one in Connections.`,
    link: connections,
  };
}

export function toolsLine(input: {
  enabledCount: number | undefined;
  failed: boolean;
  toolsTabPath: string;
}): ReadinessLine {
  const base = { id: "tools" as const, label: "Tools" };
  const link = { to: input.toolsTabPath, label: "Open the Tools tab" };
  if (input.failed) {
    return { ...base, state: "todo", text: "Could not load this agent's tools.", link };
  }
  if (input.enabledCount === undefined) {
    return { ...base, state: "checking", text: "Checking tools…" };
  }
  if (input.enabledCount === 0) {
    return {
      ...base,
      state: "todo",
      text: "No tools ticked. Fine for a plain chat helper; tick some on the Tools tab to let it do more.",
      link,
    };
  }
  return {
    ...base,
    state: "ok",
    text: `${input.enabledCount} tool${input.enabledCount === 1 ? "" : "s"} ticked.`,
    link,
  };
}

export type DataSourceCheck =
  | { kind: "checking" }
  | { kind: "feature_off" }
  | { kind: "forbidden" }
  | { kind: "failed" }
  | { kind: "loaded"; hasSales: boolean };

export function dataLine(check: DataSourceCheck): ReadinessLine {
  const base = { id: "data" as const, label: "Data" };
  const link = { to: CONNECTIONS_PATH, label: "Open Connections" };
  switch (check.kind) {
    case "checking":
      return { ...base, state: "checking", text: "Checking data sources…" };
    case "feature_off":
      return {
        ...base,
        state: "todo",
        text: "Business data is switched off for this Paperclip. An instance admin can switch it on under Instance settings → Experimental.",
      };
    case "forbidden":
      return {
        ...base,
        state: "todo",
        text: "Only the company owner can see and connect data sources.",
      };
    case "failed":
      return { ...base, state: "todo", text: "Could not check the company's data sources.", link };
    case "loaded":
      return check.hasSales
        ? {
            ...base,
            state: "ok",
            text: "Sales data is connected. Today data access is per company, so every quick agent here can read it.",
            link,
          }
        : {
            ...base,
            state: "todo",
            text: "No sales source connected yet. Connect one under Connections → Data sources if this agent should answer questions about sales.",
            link,
          };
  }
}

export function instructionsLine(instructions: string | null | undefined): ReadinessLine {
  const base = { id: "instructions" as const, label: "Instructions" };
  if (instructions && instructions.trim().length > 0) {
    return { ...base, state: "ok", text: "Instructions are set." };
  }
  return {
    ...base,
    state: "todo",
    text: "No instructions yet. Write them below so the quick agent knows who it is and what to do.",
  };
}
