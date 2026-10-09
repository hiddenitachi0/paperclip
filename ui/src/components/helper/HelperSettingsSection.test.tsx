// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperSettingsView } from "@paperclipai/shared";

/**
 * Company settings → Helper, Phase 3 part: the investigation agent picker
 * (with the plain explanation and the read-only recommendation) and the
 * per-person limits, which an owner/admin can change and others only see.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHelperApi = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api/helper", () => ({ helperApi: mockHelperApi }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: toast }) }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", issuePrefix: "ACM" } }) }));
vi.mock("../SecretBindingPicker", () => ({ SecretBindingPicker: () => <div /> }));

import { ApiError } from "../../api/client";
import { HelperSettingsSection, INVESTIGATOR_CAN_WRITE_ACK } from "./HelperSettingsSection";

function view(overrides: Partial<HelperSettingsView> = {}): HelperSettingsView {
  return {
    defaultDirectoryEntryId: null,
    investigationAgentId: null,
    investigationMaxRunning: 3,
    investigationMaxPerDay: 20,
    investigationCompanyMaxPerDay: 50,
    investigationAgent: null,
    keys: [],
    models: [],
    builtInDefaultLabel: "Claude",
    builtInDefaultCanSeePictures: true,
    builtInDefaultStatus: { kind: "paperclip_key", label: "Paperclip's key", detail: "", tone: "ok" },
    canEdit: true,
    updatedAt: null,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/ACM/company/settings"]}>
          <HelperSettingsSection companyId="c1" />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("HelperSettingsSection — investigations", () => {
  it("lets an owner/admin pick the agent (not a let-go one) and the limits, with plain explanations", async () => {
    mockHelperApi.getSettings.mockResolvedValue(view());
    mockHelperApi.updateSettings.mockImplementation(async (_c: string, patch: Record<string, unknown>) => view(patch as Partial<HelperSettingsView>));
    mockAgentsApi.list.mockResolvedValue([
      { id: "a1", name: "Investigator", status: "idle" },
      { id: "a2", name: "Sleepy", status: "paused" },
      { id: "a3", name: "Gone", status: "terminated" },
    ]);
    await render();

    const section = document.querySelector("[data-testid=helper-investigation-settings]")!;
    expect(section.textContent).toContain("Recommended: a dedicated “Investigator” agent that can only read");
    expect(section.textContent).toContain("is paid from this agent's budget");
    expect(section.textContent).toContain("The investigator can see everything in the company, and its answer goes to whoever asked.");
    const agentSelect = document.querySelector("[data-testid=helper-investigation-agent]") as HTMLSelectElement;
    const options = [...agentSelect.options].map((o) => o.textContent);
    expect(options).toEqual(["None — “Investigate deeper” is off", "Investigator", "Sleepy (paused)"]);

    await choose(agentSelect, "a1");
    expect(mockHelperApi.updateSettings).toHaveBeenLastCalledWith("c1", { investigationAgentId: "a1" });
    await choose(document.querySelector("[data-testid=helper-investigation-max-running]") as HTMLSelectElement, "5");
    expect(mockHelperApi.updateSettings).toHaveBeenLastCalledWith("c1", { investigationMaxRunning: 5 });
    await choose(document.querySelector("[data-testid=helper-investigation-max-per-day]") as HTMLSelectElement, "50");
    expect(mockHelperApi.updateSettings).toHaveBeenLastCalledWith("c1", { investigationMaxPerDay: 50 });
    await choose(document.querySelector("[data-testid=helper-investigation-company-max-per-day]") as HTMLSelectElement, "200");
    expect(mockHelperApi.updateSettings).toHaveBeenLastCalledWith("c1", { investigationCompanyMaxPerDay: 200 });
  });

  it("asks for the explicit confirmation when the picked agent can change things, and only then saves it", async () => {
    mockHelperApi.getSettings.mockResolvedValue(view());
    mockAgentsApi.list.mockResolvedValue([{ id: "a9", name: "Builder", status: "idle" }]);
    mockHelperApi.updateSettings.mockImplementation(async (_c: string, patch: Record<string, unknown>) => {
      if (!patch.acknowledgeInvestigatorCanWrite) {
        throw new ApiError("\"Builder\" can change things", 422, {
          error: "\"Builder\" can change things",
          code: "HELPER_INVESTIGATOR_CAN_WRITE",
          details: { agentId: "a9", agentName: "Builder", capabilities: ["can ask for deploys", "has secrets besides its model login (GITHUB_TOKEN)"] },
        });
      }
      return view({
        investigationAgentId: "a9",
        investigationAgent: {
          id: "a9",
          name: "Builder",
          status: "idle",
          budgetMonthlyCents: 0,
          writeCapabilities: ["can ask for deploys", "has secrets besides its model login (GITHUB_TOKEN)"],
          writeAcknowledged: true,
        },
      });
    });
    await render();
    await choose(document.querySelector("[data-testid=helper-investigation-agent]") as HTMLSelectElement, "a9");
    const box = document.querySelector("[data-testid=helper-investigator-can-write]")!;
    expect(box.textContent).toContain("It can ask for deploys.");
    expect(box.textContent).toContain("It has secrets besides its model login (GITHUB_TOKEN).");
    expect(box.textContent).toContain(INVESTIGATOR_CAN_WRITE_ACK);
    expect(INVESTIGATOR_CAN_WRITE_ACK).toBe("I understand this agent can change things and text on screen could try to make it do so.");
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
    const confirm = document.querySelector("[data-testid=helper-investigator-can-write-confirm]") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    act(() => (document.querySelector("[data-testid=helper-investigator-can-write-ack]") as HTMLInputElement).click());
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(mockHelperApi.updateSettings).toHaveBeenLastCalledWith("c1", { investigationAgentId: "a9", acknowledgeInvestigatorCanWrite: true });
    expect(document.querySelector("[data-testid=helper-investigator-can-write]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-investigator-confirmed]")?.textContent).toContain("can ask for deploys");
    expect(document.querySelector("[data-testid=helper-investigator-no-budget]")?.textContent).toContain("“Builder” has no monthly budget");
  });

  it("asks an owner/admin to confirm again when the saved agent gained rights", async () => {
    mockHelperApi.getSettings.mockResolvedValue(
      view({
        investigationAgentId: "a9",
        investigationAgent: { id: "a9", name: "Builder", status: "idle", budgetMonthlyCents: 500, writeCapabilities: ["can ask for merges"], writeAcknowledged: false },
      }),
    );
    mockHelperApi.updateSettings.mockResolvedValue(view());
    mockAgentsApi.list.mockResolvedValue([{ id: "a9", name: "Builder", status: "idle" }]);
    await render();
    expect(document.querySelector("[data-testid=helper-investigator-no-budget]")).toBeNull();
    act(() => (document.querySelector("[data-testid=helper-investigator-can-write-ack]") as HTMLInputElement).click());
    await act(async () => {
      (document.querySelector("[data-testid=helper-investigator-can-write-confirm]") as HTMLButtonElement).click();
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(mockHelperApi.updateSettings).toHaveBeenLastCalledWith("c1", { acknowledgeInvestigatorCanWrite: true });
  });

  it("shows the settings read-only to everyone else", async () => {
    mockHelperApi.getSettings.mockResolvedValue(
      view({
        canEdit: false,
        investigationMaxRunning: 7,
        investigationAgentId: "a9",
        investigationAgent: { id: "a9", name: "Builder", status: "idle", budgetMonthlyCents: 0, writeCapabilities: ["can ask for merges"], writeAcknowledged: false },
      }),
    );
    await render();
    expect((document.querySelector("[data-testid=helper-investigation-agent]") as HTMLSelectElement).disabled).toBe(true);
    const running = document.querySelector("[data-testid=helper-investigation-max-running]") as HTMLSelectElement;
    expect(running.disabled).toBe(true);
    expect(running.value).toBe("7");
    expect(mockAgentsApi.list).not.toHaveBeenCalled();
    expect(document.querySelector("[data-testid=helper-investigator-unconfirmed]")?.textContent).toContain("investigations are off");
    expect(document.querySelector("[data-testid=helper-investigator-can-write-ack]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-investigator-no-budget]")).toBeNull();
  });
});
