import { describe, expect, it, vi } from "vitest";
import {
  GET_DOCUMENT_TOOL,
  LANE_A_BUILTIN_TOOL_NAMES,
  SEARCH_DOCUMENTS_TOOL,
  buildLaneABuiltinToolDefinitions,
  createLaneABuiltinToolExecutor,
  type LaneAToolContext,
  type LaneAToolDeps,
} from "../services/lane-a-tools.js";
import type { DocumentsAnswer } from "../services/documents-data.js";

/**
 * DUR-4303: search_documents/get_document are built-in Lane A tools, run
 * against injected deps so the dispatch and the "not available" fallback
 * (when the server has not wired the deps at all, e.g. this path's company
 * has no documents feature) can be tested without a database.
 */

const companyId = "11111111-1111-4111-8111-111111111112";
const quickAgentId = "11111111-1111-4111-8111-111111111111";

function ctx(): LaneAToolContext {
  return {
    companyId,
    agent: { id: quickAgentId, name: "Ada" },
    requester: { userId: "user-1", agentId: null },
    actor: { type: "board", userId: "user-1", companyIds: [companyId], source: "session" },
    conversationId: "44444444-4444-4444-8444-444444444444",
  };
}

function minimalDeps(overrides: Partial<LaneAToolDeps> = {}): LaneAToolDeps {
  return {
    listAgents: vi.fn(async () => []),
    canAssignTask: vi.fn(async () => ({ allowed: true, explanation: "ok" })),
    createIssueForAgent: vi.fn(async () => ({ id: "issue-1", identifier: "DUR-12", status: "todo" })),
    lookupIssue: vi.fn(async () => null),
    fetch: vi.fn(async () => {
      throw new Error("network disabled in tests");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("DUR-4303 search_documents/get_document: allow-list", () => {
  it("are published tool definitions with the schema an agent needs", () => {
    const names = buildLaneABuiltinToolDefinitions().map((tool) => tool.name);
    expect(names).toContain(SEARCH_DOCUMENTS_TOOL);
    expect(names).toContain(GET_DOCUMENT_TOOL);
    expect(LANE_A_BUILTIN_TOOL_NAMES).toContain(SEARCH_DOCUMENTS_TOOL);
    expect(LANE_A_BUILTIN_TOOL_NAMES).toContain(GET_DOCUMENT_TOOL);

    const searchTool = buildLaneABuiltinToolDefinitions().find((tool) => tool.name === SEARCH_DOCUMENTS_TOOL)!;
    expect(searchTool.input_schema).toMatchObject({ required: ["query"] });
    const getTool = buildLaneABuiltinToolDefinitions().find((tool) => tool.name === GET_DOCUMENT_TOOL)!;
    expect(getTool.input_schema).toMatchObject({ required: ["id"] });
  });
});

describe("DUR-4303 search_documents dispatch", () => {
  it("refuses plainly, without guessing, when the deps are not wired", async () => {
    const deps = minimalDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(SEARCH_DOCUMENTS_TOOL, { query: "invoice" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("cannot be searched");
    expect(result.content).not.toMatch(/invoice/i);
  });

  it("calls deps.searchDocuments with the raw input and the tool context, relaying the answer", async () => {
    const answer: DocumentsAnswer = { ok: true, outcome: "ok", refusalCode: null, lookupId: "lookup-1", text: "#7 \"Leiekontrakt\"" };
    const searchDocuments = vi.fn(async () => answer);
    const deps = minimalDeps({ searchDocuments });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(SEARCH_DOCUMENTS_TOOL, { query: "leiekontrakt", tags: ["contract"] }, ctx());

    expect(searchDocuments).toHaveBeenCalledWith({ query: "leiekontrakt", tags: ["contract"] }, expect.objectContaining({ companyId }));
    expect(result.ok).toBe(true);
    expect(result.content).toBe(answer.text);
    expect(result.summary).toContain("lookup-1");
  });

  it("relays a refusal's text and summarizes the outcome/refusal code", async () => {
    const answer: DocumentsAnswer = { ok: false, outcome: "refused", refusalCode: "documents_disabled", lookupId: null, text: "Documents are switched off for this company." };
    const deps = minimalDeps({ searchDocuments: vi.fn(async () => answer) });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(SEARCH_DOCUMENTS_TOOL, { query: "x" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toBe(answer.text);
    expect(result.summary).toContain("documents_disabled");
  });
});

describe("DUR-4303 get_document dispatch", () => {
  it("refuses plainly, without guessing, when the deps are not wired", async () => {
    const deps = minimalDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(GET_DOCUMENT_TOOL, { id: 7 }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("cannot be read");
  });

  it("calls deps.getDocument with the raw input and relays the answer, including the download link", async () => {
    const answer: DocumentsAnswer = {
      ok: true,
      outcome: "ok",
      refusalCode: null,
      lookupId: "lookup-2",
      text: "#7 \"Leiekontrakt\"\nDownload (expires in 5 minutes): https://app.example/api/documents/download/tok123",
    };
    const getDocument = vi.fn(async () => answer);
    const deps = minimalDeps({ getDocument });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(GET_DOCUMENT_TOOL, { id: 7 }, ctx());

    expect(getDocument).toHaveBeenCalledWith({ id: 7 }, expect.objectContaining({ companyId }));
    expect(result.ok).toBe(true);
    expect(result.content).toBe(answer.text);
  });
});
