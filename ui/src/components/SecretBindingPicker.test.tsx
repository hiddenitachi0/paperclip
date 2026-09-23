// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ADD_NEW_SECRET_LABEL, SecretBindingPicker, type SecretBindingValue } from "./SecretBindingPicker";

/**
 * DUR-3997 "add a secret right where you need it". What the shared picker
 * must not get wrong:
 *  - the last row of the list is "Add new secret…" for someone who may add
 *    connections, and picking it opens a small dialog instead of binding;
 *  - saving creates the secret (with its kind), refreshes the list and
 *    selects the new secret in the picker;
 *  - a testable kind is checked with the provider on save and the verdict
 *    is shown inline, never the value;
 *  - a viewer sees no way to add, only the list.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const EXISTING_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_ID = "bbbbbbbb-0000-4000-8000-000000000009";
const SECRET_VALUE = "sk-" + "n0tar3alk3y0000000000000000";

const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), test: vi.fn() }));
const mockUseCompanyRole = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
// The kind dropdown is a Radix Select, which jsdom cannot open. Its own
// behaviour is not under test here; a plain <select> with the same contract
// lets these tests choose a kind.
vi.mock("./SecretKindSelect", () => ({
  SecretKindSelect: ({
    id,
    value,
    onChange,
  }: {
    id?: string;
    value: string | null;
    onChange: (kind: string | null) => void;
  }) => (
    <select
      id={id}
      data-testid="kind-select"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Not sure</option>
      <option value="openai_api_key">OpenAI API key</option>
      <option value="fiken_api_token">Fiken API token</option>
    </select>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function secret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: EXISTING_ID,
    companyId: COMPANY,
    key: "existing_key",
    name: "Existing key",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    kind: null,
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

function role(canManage: boolean) {
  return {
    role: canManage ? "owner" : "viewer",
    isInstanceAdmin: false,
    localBoard: false,
    canManageConnections: canManage,
    isLoading: false,
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

/** Type into a controlled field the way a person would, so React sees it. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, next: string) {
  const proto = Object.getPrototypeOf(element);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(element, next);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

/** A caller that keeps the binding in state, like every real screen does. */
function Harness({
  initial,
  onChange,
}: {
  initial: SecretBindingValue | null;
  onChange: (next: SecretBindingValue | null) => void;
}) {
  const [value, setValue] = useState<SecretBindingValue | null>(initial);
  return (
    <SecretBindingPicker
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      allowVersionSelector={false}
    />
  );
}

describe("SecretBindingPicker inline add", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let onChange: Mock<(next: SecretBindingValue | null) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onChange = vi.fn<(next: SecretBindingValue | null) => void>();
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.create.mockResolvedValue(secret({ id: NEW_ID, key: "openai_key", name: "OpenAI key", kind: null }));
    mockSecretsApi.test.mockResolvedValue({ ok: true, message: "OpenAI accepted the key." });
    mockUseCompanyRole.mockReturnValue(role(true));
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(initial: SecretBindingValue | null = null) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <Harness initial={initial} onChange={onChange} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function picker(): HTMLSelectElement {
    const element = container.querySelector<HTMLSelectElement>("select");
    expect(element).not.toBeNull();
    return element!;
  }

  function optionLabels(): string[] {
    return Array.from(picker().options).map((option) => option.textContent?.trim() ?? "");
  }

  function dialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="dialog"]');
  }

  function buttonByText(label: string): HTMLButtonElement {
    const match = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === label,
    );
    expect(match, `button "${label}"`).toBeDefined();
    return match as HTMLButtonElement;
  }

  it("lists Add new secret… last, creates the secret from the dialog and selects it", async () => {
    mockSecretsApi.list.mockResolvedValue([secret()]);
    await render();

    const labels = optionLabels();
    expect(labels.at(-1)).toBe(ADD_NEW_SECRET_LABEL);
    expect(labels).toContain("Existing key — local encrypted");
    expect(dialog()).toBeNull();

    // Picking the last row opens the dialog and binds nothing.
    await act(async () => {
      setNativeValue(picker(), "__add_new_secret__");
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Add new secret");
    expect(picker().value).toBe("");

    await act(async () => {
      setNativeValue(document.querySelector<HTMLInputElement>("#secret-name")!, "OpenAI key");
      setNativeValue(document.querySelector<HTMLTextAreaElement>("#secret-value")!, SECRET_VALUE);
    });
    // The list refetch after the save returns the new row.
    mockSecretsApi.list.mockResolvedValue([secret(), secret({ id: NEW_ID, key: "openai_key", name: "OpenAI key" })]);

    await act(async () => {
      buttonByText("Save & use").click();
    });
    await flush();

    expect(mockSecretsApi.create).toHaveBeenCalledWith(COMPANY, { name: "OpenAI key", value: SECRET_VALUE, kind: null });
    // A "Not sure" kind cannot be tested; nothing is sent to any provider.
    expect(mockSecretsApi.test).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ secretId: NEW_ID, version: "latest" });
    expect(dialog()).toBeNull();
    expect(mockSecretsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(picker().value).toBe(NEW_ID);
    expect(container.querySelector('[data-testid="secret-just-added"]')?.textContent).toContain(
      'Saved "OpenAI key" to Secrets and picked it here.',
    );
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
  });

  it("checks a testable kind with the provider on save and shows the verdict, never the value", async () => {
    mockSecretsApi.create.mockResolvedValue(
      secret({ id: NEW_ID, key: "openai_key", name: "OpenAI key", kind: "openai_api_key" }),
    );
    mockSecretsApi.test.mockResolvedValue({ ok: false, message: "OpenAI said: invalid key." });
    await render();

    // The + button next to the field is the other way in.
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add new secret"]');
    expect(addButton).not.toBeNull();
    await act(async () => {
      addButton!.click();
    });
    expect(dialog()).not.toBeNull();

    await act(async () => {
      setNativeValue(document.querySelector<HTMLInputElement>("#secret-name")!, "OpenAI key");
      setNativeValue(document.querySelector<HTMLSelectElement>('[data-testid="kind-select"]')!, "openai_api_key");
      setNativeValue(document.querySelector<HTMLTextAreaElement>("#secret-value")!, SECRET_VALUE);
    });
    expect(dialog()!.textContent).toContain("Paperclip will check it with the provider as soon as it is saved.");

    await act(async () => {
      buttonByText("Save & use").click();
    });
    await flush();

    expect(mockSecretsApi.create).toHaveBeenCalledWith(COMPANY, {
      name: "OpenAI key",
      value: SECRET_VALUE,
      kind: "openai_api_key",
    });
    expect(mockSecretsApi.test).toHaveBeenCalledWith(COMPANY, NEW_ID);
    expect(onChange).toHaveBeenCalledWith({ secretId: NEW_ID, version: "latest" });
    expect(dialog()).toBeNull();
    expect(picker().value).toBe(NEW_ID);
    expect(container.querySelector('[data-testid="secret-just-added"]')?.textContent).toContain(
      "Saved, but the provider did not accept it: OpenAI said: invalid key.",
    );
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
  });

  it("shows the empty hint with the inline add for a board member with no secrets", async () => {
    await render();
    expect(optionLabels()).toEqual(["Select secret", ADD_NEW_SECRET_LABEL]);
    expect(container.textContent).toContain(`Pick "${ADD_NEW_SECRET_LABEL}" to add one here.`);
  });

  it("gives a viewer the list only: no Add new secret… row, no + button", async () => {
    mockUseCompanyRole.mockReturnValue(role(false));
    mockSecretsApi.list.mockResolvedValue([secret()]);
    await render();

    expect(optionLabels()).toEqual(["Select secret", "Existing key — local encrypted"]);
    expect(container.querySelector('button[aria-label="Add new secret"]')).toBeNull();
    expect(container.textContent).not.toContain(ADD_NEW_SECRET_LABEL);

    // Still a working picker for what exists.
    await act(async () => {
      setNativeValue(picker(), EXISTING_ID);
    });
    expect(onChange).toHaveBeenCalledWith({ secretId: EXISTING_ID, version: "latest" });
  });

  it("tells a viewer with no secrets who can add one instead of pointing at a row they do not have", async () => {
    mockUseCompanyRole.mockReturnValue(role(false));
    await render();
    expect(optionLabels()).toEqual(["Select secret"]);
    expect(container.textContent).toContain("A company owner or admin can add one.");
    expect(container.textContent).not.toContain(ADD_NEW_SECRET_LABEL);
  });
});
