// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSONA_FIELD_MAX_LENGTHS } from "@paperclipai/shared";
import type { Persona } from "../api/personas";
import { applyHelperAnswer, listHelperApplyTargets, resetHelperApplyRegistryForTests } from "../lib/helper-apply";
import { PERSONA_APPLY_LABELS } from "../components/PersonaForm";
import { PERSONA_LEAVE_UNSAVED_MESSAGE, PersonaEdit } from "./PersonaEdit";

const mockPersonasApi = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as { personaId?: string } }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  useParams: () => routeParams.current,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast }),
}));
vi.mock("../api/personas", () => ({ personasApi: mockPersonasApi }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));

// Radix portals are not what these tests are about: render the confirm inline.
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="discard-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const persona: Persona = {
  id: "persona-1",
  companyId: "company-1",
  displayName: "Maja",
  pronouns: "they/them",
  traits: "Curious",
  backstory: "Grew up by the sea.",
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

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PersonaEdit page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    routeParams.current = {};
    mockPersonasApi.get.mockResolvedValue(persona);
    mockPersonasApi.create.mockResolvedValue({ ...persona, id: "persona-new" });
    mockPersonasApi.update.mockResolvedValue(persona);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
    resetHelperApplyRegistryForTests();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PersonaEdit />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  const field = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === text) ?? null;
  async function click(el: Element | null) {
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();
  }
  async function type(id: string, value: string) {
    await act(async () => {
      setValue(field<HTMLInputElement>(id), value);
    });
    await flushReact();
  }

  it("creates a persona on its own page and opens the new persona's page", async () => {
    await render();
    expect(container.textContent).toContain("New persona");
    expect(container.textContent).toContain("A person, not a job.");
    // No agent picker: a persona exists on its own.
    expect(container.querySelector("select")).toBeNull();
    // A new persona has no id yet, so there is no entity for the helper.
    expect(container.querySelector("[data-helper-entity]")).toBeNull();

    await type("persona-name", "  Maja ");
    await type("persona-traits", "Curious, dry humour");
    await type("persona-voice", "Short sentences.");
    await click(button("Save"));

    expect(mockPersonasApi.create).toHaveBeenCalledTimes(1);
    const [companyId, input] = mockPersonasApi.create.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(input).toMatchObject({ displayName: "Maja", traits: "Curious, dry humour", voice: "Short sentences.", status: "active" });
    expect(input.backstory).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Persona created" }));
    expect(navigate).toHaveBeenCalledWith("/personas/persona-new");
  });

  it("edits a persona: loads its fields, saves what changed, blanks clear a field", async () => {
    routeParams.current = { personaId: "persona-1" };
    await render();
    expect(mockPersonasApi.get).toHaveBeenCalledWith("persona-1");
    expect(container.textContent).toContain("Edit Maja");
    expect(field<HTMLInputElement>("persona-name").value).toBe("Maja");
    expect(field<HTMLTextAreaElement>("persona-backstory").value).toBe("Grew up by the sea.");
    expect(container.querySelector('[data-helper-entity="persona:persona-1"]')).not.toBeNull();
    // Nothing changed yet: nothing to save.
    expect(button("Save")!.disabled).toBe(true);

    await type("persona-backstory", "");
    await type("persona-voice", "Warm, brief.");
    expect(container.textContent).toContain("Unsaved changes");
    await click(button("Save"));

    expect(mockPersonasApi.update).toHaveBeenCalledWith(
      "persona-1",
      expect.objectContaining({ displayName: "Maja", backstory: null, voice: "Warm, brief.", pronouns: "they/them" }),
    );
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Persona saved" }));
    expect(navigate).toHaveBeenCalledWith("/personas/persona-1");
  });

  it("needs a name, and keeps the server's length limits with counters", async () => {
    await render();
    expect(button("Save")!.disabled).toBe(true);
    expect(container.querySelector('[data-testid="persona-name-required"]')).not.toBeNull();

    await type("persona-name", "   ");
    expect(button("Save")!.disabled).toBe(true);
    await type("persona-name", "Nova");
    expect(button("Save")!.disabled).toBe(false);
    expect(container.querySelector('[data-testid="persona-name-required"]')).toBeNull();
    expect(container.textContent).toContain(`4/${PERSONA_FIELD_MAX_LENGTHS.displayName}`);
    expect(field<HTMLTextAreaElement>("persona-traits").maxLength).toBe(PERSONA_FIELD_MAX_LENGTHS.traits);
    expect(field<HTMLTextAreaElement>("persona-voice").maxLength).toBe(PERSONA_FIELD_MAX_LENGTHS.voice);
  });

  it("shows a save error in plain words and stays on the page", async () => {
    routeParams.current = { personaId: "persona-1" };
    mockPersonasApi.update.mockRejectedValue(new Error("Name already taken"));
    await render();
    await type("persona-name", "Nova");
    await click(button("Save"));
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not save persona", body: "Name already taken", tone: "error" }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("cancel goes straight back when nothing changed", async () => {
    routeParams.current = { personaId: "persona-1" };
    await render();
    await click(button("Cancel"));
    expect(navigate).toHaveBeenCalledWith("/personas/persona-1");

    navigate.mockClear();
    routeParams.current = {};
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render();
    await click(button("Cancel"));
    expect(navigate).toHaveBeenCalledWith("/personas");
  });

  it("cancel with unsaved changes asks first: keep editing, or discard and leave", async () => {
    routeParams.current = { personaId: "persona-1" };
    await render();
    await type("persona-traits", "Changed my mind");
    await click(button("Cancel"));
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="discard-dialog"]')?.textContent).toContain("Discard your changes?");

    await click(button("Discard changes"));
    expect(navigate).toHaveBeenCalledWith("/personas/persona-1");
    expect(mockPersonasApi.update).not.toHaveBeenCalled();
  });

  it("asks before a link elsewhere is followed while there are unsaved changes", async () => {
    await render();
    const link = document.createElement("a");
    link.href = "/dashboard";
    document.body.appendChild(link);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    const clickLink = () => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // Clean form: links work as usual.
    expect(clickLink()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();

    await type("persona-name", "Maja");
    expect(clickLink()).toBe(true);
    expect(confirm).toHaveBeenCalledWith(PERSONA_LEAVE_UNSAVED_MESSAGE);
    confirm.mockReturnValue(true);
    expect(clickLink()).toBe(false);
  });

  it("lets Ask Paperclip fill traits, backstory and voice, without saving", async () => {
    routeParams.current = { personaId: "persona-1" };
    await render();
    for (const label of Object.values(PERSONA_APPLY_LABELS)) {
      expect(listHelperApplyTargets()).toContain(label);
      expect(container.querySelector(`[data-helper-apply="${label}"]`)).not.toBeNull();
    }
    const entity = container.querySelector('[data-helper-entity="persona:persona-1"]')!;
    expect(entity.querySelector(`[data-helper-apply="${PERSONA_APPLY_LABELS.voice}"]`)).not.toBeNull();

    await act(async () => {
      expect(applyHelperAnswer(PERSONA_APPLY_LABELS.traits, "Patient, precise")).toBe(true);
      expect(applyHelperAnswer(PERSONA_APPLY_LABELS.backstory, "x".repeat(PERSONA_FIELD_MAX_LENGTHS.backstory + 50))).toBe(true);
      expect(applyHelperAnswer(PERSONA_APPLY_LABELS.voice, "Warm and brief.")).toBe(true);
    });
    await flushReact();

    expect(field<HTMLTextAreaElement>("persona-traits").value).toBe("Patient, precise");
    expect(field<HTMLTextAreaElement>("persona-backstory").value).toHaveLength(PERSONA_FIELD_MAX_LENGTHS.backstory);
    expect(field<HTMLTextAreaElement>("persona-voice").value).toBe("Warm and brief.");
    expect(mockPersonasApi.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsaved changes");
  });

  it("removes the apply targets when the page is left", async () => {
    await render();
    expect(listHelperApplyTargets()).toContain(PERSONA_APPLY_LABELS.traits);
    await act(async () => {
      root.unmount();
    });
    expect(listHelperApplyTargets()).not.toContain(PERSONA_APPLY_LABELS.traits);
    root = createRoot(container);
  });
});
