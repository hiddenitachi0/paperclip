// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyMigrationVerifyReport, CompanyPortabilityImportResult } from "@paperclipai/shared";
import { CarrySecretsPanel, EMPTY_CARRY_SECRETS_STATE, type CarrySecretsState } from "./CarrySecretsPanel";
import { MoveCompanySection } from "./MoveCompanySection";
import { ImportResultView } from "./ImportResultView";
import { ImportSecretsFields, EMPTY_IMPORT_SECRETS_STATE, type ImportSecretsState } from "./ImportSecretsFields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  verifyMigration: vi.fn(),
  markMigrated: vi.fn(),
  undoMigrated: vi.fn(),
}));
vi.mock("../../api/companies", () => ({ companiesApi: api }));

const role = vi.hoisted(() => ({ canManageConnections: true, isInstanceAdmin: false }));
vi.mock("../../hooks/useCompanyRole", () => ({
  useCompanyRole: () => ({ role: null, localBoard: false, isLoading: false, ...role }),
}));

let root: Root | null = null;
let container: HTMLDivElement;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function q<T extends Element = HTMLElement>(testId: string) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

async function type(testId: string, value: string) {
  const input = q<HTMLInputElement>(testId)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(testId: string) {
  await act(async () => q<HTMLButtonElement>(testId)!.click());
  await flush();
}

const manifest = {
  envInputs: [
    {
      key: "SHOP_TOKEN",
      description: null,
      agentSlug: "ceo",
      projectSlug: null,
      kind: "secret" as const,
      requirement: "optional" as const,
      defaultValue: null,
      portability: "portable" as const,
    },
    {
      key: "MODE",
      description: null,
      agentSlug: "ceo",
      projectSlug: null,
      kind: "plain" as const,
      requirement: "optional" as const,
      defaultValue: "live",
      portability: "portable" as const,
    },
  ],
  agents: [{ slug: "ceo", name: "Chief" }] as any,
  projects: [],
};

function CarryHarness({ canCarry, onState }: { canCarry: boolean; onState?: (s: CarrySecretsState) => void }) {
  const [state, setState] = useState(EMPTY_CARRY_SECRETS_STATE);
  return (
    <CarrySecretsPanel
      manifest={manifest}
      canCarry={canCarry}
      state={state}
      onChange={(next) => {
        setState(next);
        onState?.(next);
      }}
    />
  );
}

describe("company migration UI", () => {
  beforeEach(() => {
    role.canManageConnections = true;
    role.isInstanceAdmin = false;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  describe("Carry these secrets (export)", () => {
    it("lists secret names only, then asks for a passphrase twice with a strength hint and the warnings", async () => {
      let last: CarrySecretsState = EMPTY_CARRY_SECRETS_STATE;
      await render(<CarryHarness canCarry onState={(s) => (last = s)} />);
      const panel = q("carry-secrets-panel")!;
      expect(panel.textContent).toContain("SHOP_TOKEN");
      expect(panel.textContent).toContain("agent Chief");
      // Plain settings are not secrets and are not offered.
      expect(panel.textContent).not.toContain("MODE");
      expect(q("carry-secrets-passphrase")).toBeNull();

      await act(async () => q<HTMLInputElement>("carry-secret-agent:ceo:SHOP_TOKEN")!.click());
      expect(last.selected.has("agent:ceo:SHOP_TOKEN")).toBe(true);
      expect(q("secrets-travel-warnings")!.textContent).toContain("cannot be recovered");
      expect(q("secrets-travel-warnings")!.textContent).toContain("different way than the file");

      await type("carry-secrets-passphrase", "short");
      expect(q("carry-secrets-strength")!.textContent).toContain("Too short");
      await type("carry-secrets-passphrase", "blue tractor singing lamp");
      expect(q("carry-secrets-strength")!.textContent).toContain("Strong");
      await type("carry-secrets-passphrase-confirm", "blue tractor");
      expect(q("carry-secrets-mismatch")).not.toBeNull();
      await type("carry-secrets-passphrase-confirm", "blue tractor singing lamp");
      expect(q("carry-secrets-mismatch")).toBeNull();
      // The passphrase field never shows its value as text.
      expect(q<HTMLInputElement>("carry-secrets-passphrase")!.type).toBe("password");
    });

    it("tells operators and viewers that only an owner or admin can carry secrets", async () => {
      await render(<CarryHarness canCarry={false} />);
      expect(q("carry-secrets-not-allowed")!.textContent).toContain("owner or an");
      expect(q("carry-secret-agent:ceo:SHOP_TOKEN")).toBeNull();
    });
  });

  describe("Secrets file (import)", () => {
    function ImportHarness({ can }: { can: boolean }) {
      const [state, setState] = useState<ImportSecretsState>(EMPTY_IMPORT_SECRETS_STATE);
      return <ImportSecretsFields canBringSecrets={can} state={state} onChange={setState} onReadError={() => undefined} />;
    }

    it("reads the chosen file and then asks for its passphrase", async () => {
      await render(<ImportHarness can />);
      const input = q<HTMLInputElement>("import-secrets-file-input")!;
      const file = new File(["sealed-blob\n"], "nordlys.secrets.enc");
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
      expect(q("import-secrets-file-name")!.textContent).toBe("nordlys.secrets.enc");
      expect(q("import-secrets-passphrase")).not.toBeNull();
      expect(q("secrets-travel-warnings")).not.toBeNull();
    });

    it("is not offered to someone who is not an owner or admin", async () => {
      await render(<ImportHarness can={false} />);
      expect(q("import-secrets-not-allowed")).not.toBeNull();
      expect(q("import-secrets-file-input")).toBeNull();
    });
  });

  describe("Mark as migrated (source company)", () => {
    const company = { id: "c1", name: "Nordlys AS", migratedToUrl: null, migratedAt: null };

    it("needs a web address, then the company's name, before it pauses anything", async () => {
      api.markMigrated.mockResolvedValue({
        companyId: "c1",
        migratedToUrl: "https://new.example.com/NOR",
        migratedAt: "2026-10-10T10:00:00.000Z",
        migratedByUserId: "u1",
        agentsPaused: 3,
        routinesPaused: 2,
      });
      await render(<MoveCompanySection company={company} />);
      expect(q<HTMLButtonElement>("move-company-mark")!.disabled).toBe(true);
      await type("move-company-url", "not a url");
      expect(q<HTMLButtonElement>("move-company-mark")!.disabled).toBe(true);
      await type("move-company-url", "https://new.example.com/NOR");
      expect(q<HTMLButtonElement>("move-company-mark")!.disabled).toBe(false);

      // First confirmation: the button only opens the second step.
      await click("move-company-mark");
      expect(api.markMigrated).not.toHaveBeenCalled();
      const confirm = q("move-company-confirm")!;
      expect(confirm.textContent).toContain("Nothing is deleted");
      expect(confirm.textContent).toContain("https://new.example.com/NOR");
      expect(q<HTMLButtonElement>("move-company-confirm-button")!.disabled).toBe(true);

      // Second confirmation: the company's name.
      await type("move-company-typed-name", "Wrong");
      expect(q<HTMLButtonElement>("move-company-confirm-button")!.disabled).toBe(true);
      await type("move-company-typed-name", "nordlys as");
      expect(q<HTMLButtonElement>("move-company-confirm-button")!.disabled).toBe(false);
      await click("move-company-confirm-button");
      expect(api.markMigrated).toHaveBeenCalledWith("c1", {
        destinationUrl: "https://new.example.com/NOR",
        confirmCompanyName: "nordlys as",
      });
      expect(q("move-company-message")!.textContent).toContain("Paused 3 agents and 2 routines");
    });

    it("offers Undo: resume here once moved", async () => {
      api.undoMigrated.mockResolvedValue({
        companyId: "c1",
        migratedToUrl: null,
        migratedAt: null,
        migratedByUserId: null,
        agentsResumed: 3,
        routinesResumed: 2,
      });
      await render(
        <MoveCompanySection company={{ ...company, migratedToUrl: "https://new.example.com/NOR", migratedAt: new Date() }} />,
      );
      expect(q("move-company-moved")!.textContent).toContain("https://new.example.com/NOR");
      await click("move-company-undo");
      expect(api.undoMigrated).toHaveBeenCalledWith("c1");
      expect(q("move-company-message")!.textContent).toContain("Resumed here");
    });

    it("hides the buttons from operators and viewers", async () => {
      role.canManageConnections = false;
      await render(<MoveCompanySection company={company} />);
      expect(q("move-company-not-allowed")).not.toBeNull();
      expect(q("move-company-mark")).toBeNull();
    });
  });

  describe("after import", () => {
    const report: CompanyMigrationVerifyReport = {
      companyId: "new-co",
      companyName: "Nordlys AS",
      checkedAt: "2026-10-10T10:00:00.000Z",
      status: "problem",
      sections: [
        { key: "agents", title: "Agents arrived", status: "ok", summary: "2 agents are here.", items: [] },
        {
          key: "claude_login",
          title: "Claude sign-in",
          status: "problem",
          summary: "Checked 1 Claude agent.",
          items: [
            {
              label: "Chief",
              status: "problem",
              detail: "Chief uses the shared Claude sign-in, and that sign-in has stopped working.",
              fixHint: "Sign in again under Settings > Instance settings > Claude sign-in.",
            },
          ],
        },
      ],
    };
    const result: CompanyPortabilityImportResult = {
      company: { id: "new-co", name: "Nordlys AS", action: "created" },
      agents: [
        { slug: "ceo", id: "a1", action: "created", name: "Chief", reason: null },
        { slug: "old", id: null, action: "skipped", name: "Old", reason: "exists" },
      ],
      projects: [{ slug: "shop", id: "p1", action: "created", name: "Webshop", reason: null }],
      envInputs: [],
      warnings: [],
      secretsReport: {
        carried: true,
        arrived: ["agent:ceo:SHOP_TOKEN"],
        notArrived: ["project:shop:MAIL_PASSWORD"],
      },
    };

    it("shows which secrets arrived, which still need a value, and the verify checklist with fix hints", async () => {
      api.verifyMigration.mockResolvedValue(report);
      const onOpen = vi.fn();
      await render(<ImportResultView result={result} onOpenCompany={onOpen} />);
      expect(q("import-secrets-arrived")!.textContent).toContain("SHOP_TOKEN");
      expect(q("import-secrets-arrived")!.textContent).toContain("agent Chief");
      expect(q("import-secrets-not-arrived")!.textContent).toContain("MAIL_PASSWORD");
      expect(q("import-secrets-not-arrived")!.textContent).toContain("project Webshop");
      expect(api.verifyMigration).toHaveBeenCalledWith("new-co");
      expect(q("migration-verify-headline")!.textContent).toContain("Some things are missing");
      const claude = q("migration-verify-section-claude_login")!;
      expect(claude.textContent).toContain("stopped working");
      expect(claude.textContent).toContain("Fix: Sign in again");
      await click("import-open-company");
      expect(onOpen).toHaveBeenCalled();
    });
  });
});
