// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineCanvas } from "./PipelineCanvas";

// @xyflow/react measures its container with ResizeObserver, which jsdom does
// not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = ResizeObserverStub;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pipelinesGetMock = vi.fn();
const createStageMock = vi.fn();
const updateStageMock = vi.fn();
const deleteStageMock = vi.fn();
const setTransitionsMock = vi.fn();
const routinesListMock = vi.fn();
const agentsListMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/pipelines", async () => {
  const actual = await vi.importActual<typeof import("../api/pipelines")>("../api/pipelines");
  return {
    ...actual,
    pipelinesApi: {
      get: (id: string) => pipelinesGetMock(id),
      createStage: (...args: unknown[]) => createStageMock(...args),
      updateStage: (...args: unknown[]) => updateStageMock(...args),
      deleteStage: (...args: unknown[]) => deleteStageMock(...args),
      setTransitions: (...args: unknown[]) => setTransitionsMock(...args),
    },
  };
});

vi.mock("../api/routines", () => ({
  routinesApi: { list: () => routinesListMock() },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: () => agentsListMock() },
}));

function pipelineFixture(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    key: "intake",
    name: "Intake",
    description: null,
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 2,
    openCaseCount: 0,
    createdAt: "",
    updatedAt: "",
    stages: [
      { id: "stage-1", pipelineId: "pipeline-1", key: "new", name: "New", kind: "working", position: 0, config: {} },
      { id: "stage-2", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 1, config: {} },
    ],
    transitions: [{ fromStageId: "stage-1", toStageId: "stage-2", label: null }],
    documentKeys: [],
    ...overrides,
  };
}

function renderWithClient() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/pipelines/pipeline-1/canvas"]}>
          <Routes>
            <Route path="/pipelines/:pipelineId/canvas" element={<PipelineCanvas />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("PipelineCanvas", () => {
  beforeEach(() => {
    pipelinesGetMock.mockReset().mockResolvedValue(pipelineFixture());
    createStageMock.mockReset().mockResolvedValue({ id: "stage-3" });
    updateStageMock.mockReset().mockResolvedValue({});
    deleteStageMock.mockReset().mockResolvedValue({ deleted: true });
    setTransitionsMock.mockReset().mockResolvedValue({ transitions: [] });
    routinesListMock.mockReset().mockResolvedValue([]);
    agentsListMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders existing stages as canvas nodes", async () => {
    const { container, unmount } = renderWithClient();
    await flush();
    expect(container.textContent).toContain("New");
    expect(container.textContent).toContain("Needs review");
    unmount();
  });

  it("shows an empty state with an add-stage affordance when the pipeline has no stages", async () => {
    pipelinesGetMock.mockResolvedValue(pipelineFixture({ stages: [], transitions: [] }));
    const { container, unmount } = renderWithClient();
    await flush();
    expect(container.textContent).toContain("No stages yet");
    unmount();
  });

  it("creates a stage from the add-stage dialog", async () => {
    const { container, unmount } = renderWithClient();
    await flush();

    const addButton = Array.from(container.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === "Add stage");
    expect(addButton).toBeTruthy();
    act(() => addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const nameInput = document.body.querySelector("input") as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput, "Needs legal sign-off");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const dialogAddButton = Array.from(document.body.querySelectorAll("button")).filter(
      (btn) => btn.textContent?.trim() === "Add stage",
    ).pop();
    act(() => dialogAddButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(createStageMock).toHaveBeenCalledWith(
      "pipeline-1",
      expect.objectContaining({ name: "Needs legal sign-off", kind: "working" }),
    );
    unmount();
  });

  it("rejects a duplicate stage name before calling the API", async () => {
    const { container, unmount } = renderWithClient();
    await flush();

    const addButton = Array.from(container.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === "Add stage");
    act(() => addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const nameInput = document.body.querySelector("input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput, "New");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const dialogAddButton = Array.from(document.body.querySelectorAll("button")).filter(
      (btn) => btn.textContent?.trim() === "Add stage",
    ).pop();
    act(() => dialogAddButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(createStageMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("A stage with this name already exists.");
    unmount();
  });

  it("opens the properties panel and saves a renamed stage", async () => {
    const { container, unmount } = renderWithClient();
    await flush();

    const editButton = container.querySelector('button[aria-label="Edit New"]') as HTMLButtonElement;
    expect(editButton).toBeTruthy();
    act(() => editButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("Stage properties");
    const panelNameInput = container.querySelector('input[value="New"]') as HTMLInputElement;
    expect(panelNameInput).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(panelNameInput, "Intake received");
      panelNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === "Save");
    act(() => saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(updateStageMock).toHaveBeenCalledWith(
      "pipeline-1",
      "stage-1",
      expect.objectContaining({ name: "Intake received", kind: "working" }),
    );
    unmount();
  });

  it("asks to delete a stage and move its items first", async () => {
    const { container, unmount } = renderWithClient();
    await flush();

    const deleteButton = container.querySelector('button[aria-label="Delete New"]') as HTMLButtonElement;
    act(() => deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(document.body.textContent).toContain("Delete stage");
    expect(document.body.textContent).toContain("Move existing items to");

    // The dialog's own confirm button is disabled until a destination stage is chosen.
    const dialogDeleteButtons = Array.from(document.body.querySelectorAll("button")).filter(
      (btn) => btn.textContent?.trim() === "Delete stage",
    );
    const dialogConfirm = dialogDeleteButtons[dialogDeleteButtons.length - 1];
    expect(dialogConfirm.hasAttribute("disabled")).toBe(true);
    unmount();
  });
});
