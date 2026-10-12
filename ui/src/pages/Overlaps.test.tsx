// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverlapSummary } from "../api/overlaps";
import { openOverlapsForIssue, overlapAdvice, overlapWhat } from "../lib/overlap-words";
import { Overlaps } from "./Overlaps";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const mockOverlapsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/overlaps", () => ({ overlapsApi: mockOverlapsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const task = (id: string, identifier: string, title: string) => ({
  id,
  identifier,
  title,
  status: "in_progress",
  assigneeAgentId: null,
  assigneeName: "Maja",
});

const fileOverlap: OverlapSummary = {
  id: "o1",
  kind: "file",
  detail: { file: "server/src/a.ts" },
  firstDetectedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  warnedAt: null,
  issueA: task("a", "DUR-1", "First job"),
  issueB: task("b", "DUR-2", "Second job"),
};

describe("Overlaps page", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Overlaps />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it("lists both tasks, what they clash on, and what to do", async () => {
    mockOverlapsApi.list.mockResolvedValue([fileOverlap]);
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Both change the file server/src/a.ts");
    expect(text).toContain("First job");
    expect(text).toContain("Second job");
    expect(text).toContain("with Maja");
    expect(text).toContain("Let one task finish first");
  });

  it("says so when nothing overlaps", async () => {
    mockOverlapsApi.list.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("No overlapping work right now.");
  });

  it("words migration clashes and finds overlaps for one task", () => {
    const m: OverlapSummary = { ...fileOverlap, kind: "migration_number", detail: { migrationNumber: "0225" } };
    expect(overlapWhat(m)).toBe("Both want database change number 0225");
    expect(overlapAdvice(m)).toContain("next free number");
    expect(openOverlapsForIssue([fileOverlap, m], "b")).toHaveLength(2);
    expect(openOverlapsForIssue([fileOverlap], "zzz")).toHaveLength(0);
  });
});
