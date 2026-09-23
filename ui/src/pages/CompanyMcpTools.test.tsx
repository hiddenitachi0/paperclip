// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyMcpTools } from "./CompanyMcpTools";

/**
 * DUR-3997 "add a secret right where you need it", Tools page. A credential
 * row (env var or header) uses the shared secret picker, so with zero secrets
 * the row offers "Add new secret…" inline instead of sending the operator to
 * Settings → Secrets. A viewer keeps a plain list with no way to add.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), test: vi.fn() }));
const mockMcpApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
const mockOAuthApi = vi.hoisted(() => ({ start: vi.fn(), status: vi.fn() }));
const mockUseCompanyRole = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/mcpToolLibrary", () => ({ mcpToolLibraryApi: mockMcpApi, mcpOAuthApi: mockOAuthApi }));
// Radix Select cannot open in jsdom; the kind dropdown is covered by its own
// component and by SecretBindingPicker.test.tsx.
vi.mock("../components/SecretKindSelect", () => ({
  SecretKindSelect: ({ id }: { id?: string }) => <select id={id} data-testid="kind-select" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function setSelectValue(element: HTMLSelectElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(element, next);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("CompanyMcpTools credential rows", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockMcpApi.list.mockResolvedValue([]);
    mockSecretsApi.list.mockResolvedValue([]);
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

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <CompanyMcpTools />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function buttonByText(label: string, scope: ParentNode = document): HTMLButtonElement {
    const match = Array.from(scope.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === label,
    );
    expect(match, `button "${label}"`).toBeDefined();
    return match as HTMLButtonElement;
  }

  function dialogs(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  }

  /** Open "Add tool" and add one credential row; returns that row. */
  async function openToolWithOneRow(): Promise<HTMLElement> {
    await act(async () => {
      buttonByText("Add tool", container).click();
    });
    await flush();
    const [toolDialog] = dialogs();
    expect(toolDialog, "tool dialog").toBeDefined();
    expect(toolDialog.textContent).toContain("Headers (optional)");
    await act(async () => {
      buttonByText("Add", toolDialog).click();
    });
    await flush();
    const row = toolDialog.querySelector<HTMLElement>('[data-testid="credential-row"]');
    expect(row, "credential row").not.toBeNull();
    return row!;
  }

  it("offers Add new secret… inline on a row when the company has no secrets yet", async () => {
    await render();
    const row = await openToolWithOneRow();

    const picker = row.querySelector<HTMLSelectElement>("select");
    expect(picker).not.toBeNull();
    const labels = Array.from(picker!.options).map((option) => option.textContent?.trim());
    expect(labels).toEqual(["Pick a saved secret", "Add new secret…"]);
    expect(row.textContent).toContain('No secrets yet. Pick "Add new secret…" to add one without leaving this page.');
    expect(document.body.textContent).not.toContain("Settings → Secrets");

    // Picking it opens the small add dialog on top of the tool dialog.
    await act(async () => {
      setSelectValue(picker!, "__add_new_secret__");
    });
    await flush();
    const open = dialogs();
    expect(open).toHaveLength(2);
    expect(open[1].textContent).toContain("Add new secret");
    expect(open[1].querySelector("#secret-name")).not.toBeNull();
    expect(open[1].querySelector("#secret-value")).not.toBeNull();
    expect(open[1].querySelector('[data-testid="kind-select"]')).not.toBeNull();
    expect(buttonByText("Save & use", open[1])).toBeDefined();
  });

  it("keeps the OAuth sign-in note and the header/env switch as they were", async () => {
    await render();
    const row = await openToolWithOneRow();
    const [toolDialog] = dialogs();
    expect(toolDialog.textContent).toContain('Save the tool first if it needs "Connect & sign in" instead of a pasted key.');

    await act(async () => {
      buttonByText("Runs a command", toolDialog).click();
    });
    await flush();
    expect(toolDialog.textContent).toContain("Environment variables (optional)");
    // The row survives the switch and still carries the inline add.
    expect(row.isConnected).toBe(true);
    const labels = Array.from(row.querySelector<HTMLSelectElement>("select")!.options).map((option) =>
      option.textContent?.trim(),
    );
    expect(labels).toContain("Add new secret…");
  });

  it("gives a viewer a plain list with no inline add", async () => {
    mockUseCompanyRole.mockReturnValue(role(false));
    await render();
    const row = await openToolWithOneRow();

    const labels = Array.from(row.querySelector<HTMLSelectElement>("select")!.options).map((option) =>
      option.textContent?.trim(),
    );
    expect(labels).toEqual(["Pick a saved secret"]);
    expect(row.querySelector('button[aria-label="Add new secret"]')).toBeNull();
    expect(row.textContent).toContain("A company owner or admin can add one.");
    expect(row.textContent).not.toContain("Add new secret…");
  });
});
