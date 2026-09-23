import type { CompanySecret, LaneAProvider } from "@paperclipai/shared";

/**
 * DUR-3997: the quick-agent readiness checklist, as plain data.
 *
 * Four lines. Each is green ("ok"), a gentle to-do ("todo": the agent works
 * without it), or a blocker ("blocked": the agent cannot be switched on).
 * Only the model-and-key line can block; tools, data and instructions are
 * optional by design. The wording is what the operator reads, so every text
 * says what to do next, never just what is wrong.
 *
 * Pure functions so the states can be tested without rendering anything.
 */
export type ReadinessState = "ok" | "todo" | "blocked" | "checking";

export interface ReadinessLine {
  id: "model" | "tools" | "data" | "instructions";
  label: string;
  state: ReadinessState;
  text: string;
  /** Where to go to fix it, if anywhere. */
  link?: { to: string; label: string };
}

export const CONNECTIONS_PATH = "/company/settings/connections";

export function modelAndKeyLine(input: {
  provider: LaneAProvider;
  providerLabel: string;
  /** The secret_ref bound at adapterConfig.laneA.apiKey, if any. */
  bindingSecretId: string | null;
  /** The bound secret once the company's list has loaded; undefined while loading. */
  boundSecret: CompanySecret | null | undefined;
  /** Paperclip's own key: null when the viewer may not see it, undefined while loading. */
  instanceKeyConfigured: boolean | null | undefined;
  /** For local models: the model address on the agent. */
  baseUrl: string | null;
}): ReadinessLine {
  const base = { id: "model" as const, label: "Model and key" };
  const connections = { to: CONNECTIONS_PATH, label: "Open Connections" };

  if (input.bindingSecretId) {
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
    if (secret.status !== "active") {
      return {
        ...base,
        state: "blocked",
        text: `The key "${secret.name}" is ${secret.status}. Enable it in Secrets or pick another key below.`,
        link: { to: "/company/settings/secrets", label: "Open Secrets" },
      };
    }
    if (secret.lastTestOk === false) {
      return {
        ...base,
        state: "blocked",
        text: `${input.providerLabel} refused the key "${secret.name}" when it was last tested. Test it again in Connections, or pick another key below.`,
        link: connections,
      };
    }
    const tested = secret.lastTestOk === true ? "tested and working" : "not tested yet";
    return {
      ...base,
      state: "ok",
      text: `${input.providerLabel} · the company's key "${secret.name}" (${tested}).`,
    };
  }

  if (input.provider === "anthropic") {
    if (input.instanceKeyConfigured === false) {
      return {
        ...base,
        state: "blocked",
        text: "Claude · Paperclip has no key of its own yet. Add a company key below, or add Paperclip's own key under Claude sign-in.",
        link: connections,
      };
    }
    return {
      ...base,
      state: "ok",
      text: "Claude · Paperclip's own key. Add a company key below to use your own instead.",
    };
  }

  if (input.provider === "local") {
    if (!input.baseUrl || input.baseUrl.trim() === "") {
      return {
        ...base,
        state: "blocked",
        text: "Local model · enter the model address below first (for example http://localhost:11434/v1).",
      };
    }
    return {
      ...base,
      state: "ok",
      text: `Local model at ${input.baseUrl.trim()} · no key needed.`,
    };
  }

  return {
    ...base,
    state: "blocked",
    text: `${input.providerLabel} · no key yet. Pick one below, or add one in Connections.`,
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
