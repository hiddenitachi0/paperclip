// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";
import { PERSONA_VOICE_WINS_HINT } from "./AgentPersonaFields";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModelProfiles: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
}));

const mockPersonasApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/personas", () => ({
  personasApi: mockPersonasApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../adapters", () => ({
  getUIAdapter: (type: string) => ({
    type,
    label: type === "hermes_gateway" ? "Hermes Gateway" : "Codex",
    ConfigFields: ({ adapterType }: { adapterType: string }) =>
      adapterType === "hermes_gateway"
        ? <div data-testid="hermes-gateway-config-fields">Hermes Gateway fields</div>
        : null,
    buildAdapterConfig: () => ({}),
    parseStdoutLine: () => [],
  }),
}));

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) =>
    adapterType === "hermes_gateway"
      ? {
          supportsInstructionsBundle: false,
          supportsSkills: false,
          supportsLocalAgentJwt: false,
          requiresMaterializedRuntimeSkills: false,
          supportsModelProfiles: false,
        }
      : {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsModelProfiles: true,
        },
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => [],
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    role: "Engineer",
    title: null,
    icon: null,
    avatarAssetId: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The input a "Pictures per day"-style label points at. */
function inputForLabel(container: HTMLElement, text: string): HTMLInputElement | HTMLTextAreaElement | null {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.trim() === text);
  if (!label?.htmlFor) return null;
  // useId() ids carry colons, so go through getElementById rather than a selector.
  const element = document.getElementById(label.htmlFor);
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
}

function personalityEditor(container: HTMLElement): HTMLTextAreaElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea")).find((el) =>
      el.getAttribute("aria-label")?.startsWith("Backstory, likes and dislikes"),
    ) ?? null
  );
}

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
  options: { showAdapterTestEnvironmentButton?: boolean } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="edit"
            agent={makeAgent(agentOverrides)}
            onSave={vi.fn()}
            hidePromptTemplate
            showAdapterTypeField={false}
            showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root };
}

describe("AgentConfigForm environment selector", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockPersonasApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides the environment override when Local is the only configured environment", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ]);
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Environment override");
    expect(result.container.querySelector('select[aria-label="Environment override"]')).toBeNull();
  });

  it("shows concise Environment copy when one runnable non-local environment exists", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ]);
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector('select[aria-label="Environment override"]');

    expect(text).toContain("Environment");
    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("E2B · sandbox");
    expect(text).not.toContain("Execution");
    expect(text).not.toContain("Leave this unset to inherit the instance default");
    expect(text).not.toContain("Inherit instance default");
  });

  it("keeps an existing non-runnable override visible so it can be cleared", async () => {
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "fake-sandbox-1",
          name: "Fake Sandbox",
          driver: "sandbox",
          config: { provider: "fake" },
        }),
      ],
      { defaultEnvironmentId: "fake-sandbox-1" },
    );
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector('select[aria-label="Environment override"]');

    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("Fake Sandbox · sandbox");
  });

  it("renders non-local adapter config fields in the Adapter card", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        adapterType: "hermes_gateway",
        adapterConfig: {
          apiBaseUrl: "http://127.0.0.1:8642",
          apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    );
    roots.push(result.root);

    expect(result.container.querySelector('[data-testid="hermes-gateway-config-fields"]')).toBeTruthy();
    expect(result.container.textContent).toContain("Hermes Gateway fields");
  });

  it("tests both the primary and cheap models when a cheap profile is configured", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: {
              model: "gpt-5.4-mini",
              baseUrl: "https://cheap-models.example.test",
              provider: "budget-provider",
            },
          },
        },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: expect.objectContaining({ model: "gpt-5.4" }),
    });
    expect(mockAgentsApi.testEnvironment.mock.calls[1]?.[2]).toMatchObject({
      adapterConfig: expect.objectContaining({
        model: "gpt-5.4-mini",
        baseUrl: "https://cheap-models.example.test",
        provider: "budget-provider",
      }),
    });
  });

  it("flushes pending environment variable edits before testing adapter config", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: {
        model: "gpt-5.4",
        env: { API_TOKEN: { type: "plain", value: "old-token" } },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const valueInput = result.container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]');
    expect(valueInput).toBeTruthy();

    await act(async () => {
      setInputValue(valueInput!, "draft-token");
    });
    await flushReact();

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
    for (const call of mockAgentsApi.testEnvironment.mock.calls) {
      expect(call).toEqual([
        "company-1",
        "codex_local",
        expect.objectContaining({
          adapterConfig: expect.objectContaining({
            env: { API_TOKEN: { type: "plain", value: "draft-token" } },
          }),
        }),
      ]);
    }
  });

  it("surfaces request failures instead of converting them into model test checks", async () => {
    mockAgentsApi.testEnvironment.mockRejectedValueOnce(new Error("Network unavailable"));

    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "gpt-5.4-mini" },
          },
        },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
    expect(result.container.textContent).toContain("Network unavailable");
  });

  // Polish round 3: per-agent run time limits on the agent settings page.
  it("shows the per-agent run time limits with the instance default as placeholder, and saves a cleared field as 'use the instance default'", async () => {
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      executionMode: "any",
      maxRunDurationMinutes: 150,
      silentRunTimeoutMinutes: 20,
    });
    mockEnvironmentsApi.list.mockResolvedValue([makeEnvironment({ id: "local-1", name: "Local", driver: "local" })]);
    const onSave = vi.fn().mockResolvedValue(undefined);
    let saveAction: (() => void | Promise<void>) | null = null;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AgentConfigForm
              mode="edit"
              agent={makeAgent({ adapterConfig: { maxRunDurationMinutes: 30 } })}
              onSave={onSave}
              onSaveActionChange={(action) => {
                saveAction = action;
              }}
              hidePromptTemplate
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={false}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const maxInput = container.querySelector<HTMLInputElement>('[data-testid="agent-max-run-duration-minutes"]');
    const silentInput = container.querySelector<HTMLInputElement>('[data-testid="agent-silent-run-timeout-minutes"]');
    expect(maxInput?.value).toBe("30");
    expect(silentInput?.value).toBe("");
    expect(silentInput?.placeholder).toBe("Instance default: 20 min");
    expect(container.textContent).toContain("Stop a run after (min)");
    expect(container.textContent).toContain("Stop a silent run after (min)");

    // Switch the silence limit off for this agent, and go back to the
    // instance default for the max duration.
    await act(async () => {
      setInputValue(silentInput!, "0");
      silentInput!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      setInputValue(maxInput!, "");
      maxInput!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flushReact();

    expect(saveAction).not.toBeNull();
    await act(async () => {
      await saveAction!();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0] as { adapterConfig: Record<string, unknown>; replaceAdapterConfig: boolean };
    expect(patch.replaceAdapterConfig).toBe(true);
    expect(patch.adapterConfig.silentRunTimeoutMinutes).toBe(0);
    expect(patch.adapterConfig).not.toHaveProperty("maxRunDurationMinutes");
  });
});

// DUR-4000: a persona is a person, an agent is a job. The Identity section
// gets a Persona picker; while a persona is attached the Personality field is
// hidden and Tone says the persona's voice wins. The Limits box is the job's
// own and round-trips as one `limits` field.
describe("AgentConfigForm persona and limits (DUR-4000)", () => {
  let roots: Root[] = [];

  const maja = {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    displayName: "Maja",
    pronouns: "she/her",
    traits: null,
    backstory: null,
    voice: "Short sentences.",
    avatarAssetId: null,
    handle: "maja",
    status: "active",
    publishingPaused: false,
    agentIds: [],
    agentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: false });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockPersonasApi.list.mockResolvedValue([maja]);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderEditForm(agentOverrides: Partial<Agent>) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const onSave = vi.fn();
    let saveAction: (() => void) | null = null;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AgentConfigForm
              mode="edit"
              agent={makeAgent(agentOverrides)}
              onSave={onSave}
              onSaveActionChange={(action) => {
                saveAction = action;
              }}
              hidePromptTemplate
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={false}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return { container, onSave, save: () => saveAction?.() };
  }

  it("shows Personality for a blank job and never says she/her", async () => {
    const { container } = await renderEditForm({});
    const text = container.textContent ?? "";

    expect(personalityEditor(container)).not.toBeNull();
    expect(text).not.toContain(PERSONA_VOICE_WINS_HINT);
    // The only gendered words on the form are the persona's own pronouns in the picker.
    expect(text.replace("Maja (she/her)", "")).not.toMatch(/\b(she|her)\b/i);
    expect(personalityEditor(container)?.getAttribute("aria-label")).not.toMatch(/\b(she|her)\b/i);

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Persona"]');
    expect(picker?.value).toBe("");
    expect(picker?.textContent).toContain("None");
    expect(picker?.textContent).toContain("Maja (she/her)");
    expect(text).toContain("Create one");
  });

  it("hides Personality and says the persona's voice wins while a persona is attached", async () => {
    const { container } = await renderEditForm({ personaId: maja.id, personality: "Old personality text" });

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Persona"]');
    expect(picker?.value).toBe(maja.id);
    expect(personalityEditor(container)).toBeNull();
    expect(container.textContent).toContain(PERSONA_VOICE_WINS_HINT);
    // Tone stays editable as the default for when the persona has no voice.
    expect(container.textContent).toContain("Tone");
  });

  it("attaching a persona from the picker hides Personality and saves personaId", async () => {
    const { container, onSave, save } = await renderEditForm({});
    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Persona"]');
    expect(personalityEditor(container)).not.toBeNull();

    await act(async () => {
      setSelectValue(picker!, maja.id);
    });
    await flushReact();

    expect(personalityEditor(container)).toBeNull();
    expect(container.textContent).toContain(PERSONA_VOICE_WINS_HINT);

    await act(async () => {
      await save();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ personaId: maja.id });

    // Detaching sends null, not "".
    await act(async () => {
      setSelectValue(picker!, "");
    });
    await flushReact();
    expect(personalityEditor(container)).not.toBeNull();
  });

  it("round-trips the Limits box as one `limits` field and says which limits are enforced", async () => {
    const { container, onSave, save } = await renderEditForm({
      limits: { dailyImageGenerations: 3, notes: "Do not repeat mistakes you made before." },
    });
    const text = container.textContent ?? "";

    expect(text).toContain("Limits");
    expect(text).toContain("Pictures per day");
    expect(text).toContain("Posts per day");
    expect(text).toContain("Runs per day");
    expect(text).toContain("Standing rules");
    expect(text).toContain("Enforced");
    expect(text).toContain("Guidance");

    const pictures = inputForLabel(container, "Pictures per day") as HTMLInputElement | null;
    const posts = inputForLabel(container, "Posts per day") as HTMLInputElement | null;
    const runs = inputForLabel(container, "Runs per day") as HTMLInputElement | null;
    const notes = inputForLabel(container, "Standing rules") as HTMLTextAreaElement | null;
    expect(pictures?.value).toBe("3");
    expect(posts?.value).toBe("");
    expect(runs?.value).toBe("");
    expect(notes?.value).toBe("Do not repeat mistakes you made before.");

    await act(async () => {
      setInputValue(pictures!, "5");
      setInputValue(posts!, "2");
    });
    await flushReact();

    await act(async () => {
      await save();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    // One whole `limits` object, so the server can replace the column in one go.
    expect((onSave.mock.calls[0]![0] as { limits: unknown }).limits).toEqual({
      dailyImageGenerations: 5,
      dailyPosts: 2,
      notes: "Do not repeat mistakes you made before.",
    });
  });

  it("clearing a limit sends null for that key so the server reads 'no limit'", async () => {
    const { container, onSave, save } = await renderEditForm({ limits: { dailyImageGenerations: 3 } });
    const pictures = inputForLabel(container, "Pictures per day") as HTMLInputElement | null;

    await act(async () => {
      setInputValue(pictures!, "");
    });
    await flushReact();
    await act(async () => {
      await save();
    });
    expect((onSave.mock.calls[0]![0] as { limits: unknown }).limits).toEqual({ dailyImageGenerations: null });
  });
});
