// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_DONE_GATE_SETTINGS,
  DEFAULT_QUIET_MODE_STATE,
  DONE_GATE_MODES,
  type DoneGateStatus,
  type InstanceGeneralSettings as InstanceGeneralSettingsPayload,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
  getDoneGateStatus: vi.fn(),
  listMaxTurnsAgentOverrides: vi.fn(),
  clearMaxTurnsAgentOverrides: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn(async () => ({ deploymentMode: "local_trusted", deploymentExposure: "private" })) },
}));

vi.mock("@/api/auth", () => ({
  authApi: { signOut: vi.fn() },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function defaultGeneralSettings(): InstanceGeneralSettingsPayload {
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: "prompt",
    backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 6 },
    instructionsStalenessThresholdDays: 30,
    globalMaxConcurrentRuns: 4,
    maxRunDurationMinutes: 60,
    silentRunTimeoutMinutes: 20,
    maxTurnsPerRun: 100,
    sessionResetAfterRuns: 20,
    sessionResetAfterHours: 12,
    quietMode: DEFAULT_QUIET_MODE_STATE,
    mergePrAutomationEnabled: false,
    factCheckCardStrictAllowlist: false,
    doneGate: DEFAULT_DONE_GATE_SETTINGS,
  };
}

function doneGateStatus(overrides: Partial<DoneGateStatus> = {}): DoneGateStatus {
  return {
    mode: "off",
    maxRounds: 2,
    companyOverrideCount: 0,
    ready: true,
    notReadyReason: null,
    model: "claude-haiku-4-5",
    maxCostCentsPerCheck: 2,
    ...overrides,
  };
}

describe("InstanceGeneralSettings -- quality check before a task is marked done (DUR-3968)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let currentGeneral: InstanceGeneralSettingsPayload;

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentGeneral = defaultGeneralSettings();
    mockInstanceSettingsApi.getGeneral.mockImplementation(async () => ({ ...currentGeneral }));
    mockInstanceSettingsApi.updateGeneral.mockImplementation(async (patch) => {
      currentGeneral = { ...currentGeneral, ...patch };
      return { ...currentGeneral };
    });
    mockInstanceSettingsApi.getDoneGateStatus.mockResolvedValue(doneGateStatus());
    mockInstanceSettingsApi.listMaxTurnsAgentOverrides.mockResolvedValue({ agentCount: 0, agents: [] });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  function modeButtons() {
    const group = container.querySelector('[aria-label="Quality check mode"]');
    return [...(group?.querySelectorAll("button") ?? [])];
  }

  // The two-lists rule: the modes the platform supports and the buttons the operator
  // can press are two lists that must agree, and nothing else enforces it.
  it("offers a button for every mode the platform supports", async () => {
    await renderPage();
    expect(modeButtons()).toHaveLength(DONE_GATE_MODES.length);
    expect(modeButtons().every((button) => (button.textContent ?? "").trim().length > 0)).toBe(true);
  });

  it("says in plain words that nothing is being checked while the mode is off", async () => {
    await renderPage();
    const state = container.querySelector('[data-testid="done-gate-state"]');
    expect(state?.textContent).toContain("Right now: off");
    expect(container.querySelector('[data-testid="done-gate-not-ready"]')).toBeNull();
  });

  it("says what one check costs, so switching it on is an informed choice", async () => {
    await renderPage();
    const cost = container.querySelector('[data-testid="done-gate-cost"]');
    expect(cost?.textContent).toContain("claude-haiku-4-5");
    expect(cost?.textContent).toContain("2 cents");
  });

  it("warns loudly when the check is switched on but cannot actually run", async () => {
    currentGeneral = { ...currentGeneral, doneGate: { mode: "enforce", maxRounds: 2, companyOverrides: {} } };
    mockInstanceSettingsApi.getDoneGateStatus.mockResolvedValue(
      doneGateStatus({ mode: "enforce", ready: false, notReadyReason: "This instance has no Anthropic API key of its own." }),
    );
    await renderPage();
    const warning = container.querySelector('[data-testid="done-gate-not-ready"]');
    expect(warning?.textContent).toContain("cannot run");
    expect(warning?.textContent).toContain("no Anthropic API key");
    expect(warning?.textContent).toContain("unchecked");
  });

  it("does not warn when the check is on and able to run", async () => {
    currentGeneral = { ...currentGeneral, doneGate: { mode: "enforce", maxRounds: 2, companyOverrides: {} } };
    mockInstanceSettingsApi.getDoneGateStatus.mockResolvedValue(doneGateStatus({ mode: "enforce", ready: true }));
    await renderPage();
    expect(container.querySelector('[data-testid="done-gate-not-ready"]')).toBeNull();
    expect(container.querySelector('[data-testid="done-gate-state"]')?.textContent).toContain("Right now: on");
  });
});
