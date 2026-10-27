import { afterEach, describe, expect, it, vi } from "vitest";
import { contractVersionLinkConfirmationKey } from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { CONTRACT_TOOL_NAMES, createContractToolDefinitions } from "./contract-tools.js";
import { createPaperclipMcpServer } from "./index.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const config = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: COMPANY,
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

const NEW_ID = "44444444-4444-4444-8444-444444444444";
const OLD_ID = "55555555-5555-4555-8555-555555555555";

function tool(name: string) {
  const found = createContractToolDefinitions(new PaperclipApiClient(config)).find((t) => t.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function stubFetch(body: unknown = { ok: true }, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("contract register MCP tools (DUR-4856)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes exactly the contract tools, on the main Paperclip MCP server", () => {
    const tools = createContractToolDefinitions(new PaperclipApiClient(config));
    expect(tools.map((t) => t.name)).toEqual([...CONTRACT_TOOL_NAMES]);
    const { tools: all } = createPaperclipMcpServer(config);
    for (const name of CONTRACT_TOOL_NAMES) expect(all.some((t) => t.name === name)).toBe(true);
  });

  it("has no tool that could accept, approve or resolve a confirmation", () => {
    for (const t of createContractToolDefinitions(new PaperclipApiClient(config))) {
      // The only way to produce an accepted card is the board's accept route; nothing here calls it.
      expect(Object.keys(t.schema.shape).some((k) => /accept|approve|decision|resolve/i.test(k))).toBe(false);
    }
  });

  it("register_contract sends the whole intake to the one atomic register route, for the agent's own company", async () => {
    const fetchMock = stubFetch({ id: NEW_ID, partyCount: 1, termCount: 1, deadlineCount: 1 }, 201);
    const intake = {
      title: "Warehouse lease",
      type: "rental_lease",
      parties: [{ name: "Landlord AS", role: "landlord" }],
      terms: [{ key: "notice_period_days", valueKind: "number", numberValue: 90, clauseRef: "12.1", pageRef: "7" }],
      deadlines: [{ kind: "notice_terminate", dueDate: "2027-03-31", clauseRef: "12.1" }],
    };
    const result = await tool("register_contract").execute(intake);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY}/contracts/register`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(intake);
    expect(result.content[0]!.text).toContain(NEW_ID);
  });

  it("register_contract refuses a 'not mentioned' term that carries a number, before any call is made", async () => {
    const fetchMock = stubFetch();
    const result = await tool("register_contract").execute({
      title: "x",
      type: "nda",
      terms: [{ key: "liability_cap", valueKind: "not_mentioned", numberValue: 0 }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toContain("error");
  });

  it("link_contract_version dry run returns the confirmation target key and calls nothing", async () => {
    const fetchMock = stubFetch();
    const result = await tool("link_contract_version").execute({
      contractId: NEW_ID,
      previousContractId: OLD_ID,
      changeSummary: "Rent +3%",
      carryDeadlines: true,
      dryRun: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      dryRun: true,
      confirmationTargetKey: contractVersionLinkConfirmationKey(NEW_ID, OLD_ID),
    });
  });

  it("link_contract_version passes the accepted confirmation id to the server, which does the checking", async () => {
    const fetchMock = stubFetch({ versionNo: 2 });
    const confirmationInteractionId = "66666666-6666-4666-8666-666666666666";
    await tool("link_contract_version").execute({
      contractId: NEW_ID,
      previousContractId: OLD_ID,
      changeSummary: "Rent +3%",
      carryDeadlines: false,
      confirmationInteractionId,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY}/contracts/${NEW_ID}/link-previous-version`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      previousContractId: OLD_ID,
      changeSummary: "Rent +3%",
      carryDeadlines: false,
      confirmationInteractionId,
    });
  });

  it("shows the server's refusal as-is when the link has no accepted confirmation", async () => {
    stubFetch({ error: "Linking a contract version needs a confirmation that a board member accepted." }, 403);
    const result = await tool("link_contract_version").execute({
      contractId: NEW_ID,
      previousContractId: OLD_ID,
      changeSummary: "x",
      carryDeadlines: true,
    });
    expect(result.content[0]!.text).toContain("board member accepted");
    expect(result.content[0]!.text).toContain("403");
  });

  it("aggregate_term always asks for the coverage report", async () => {
    const fetchMock = stubFetch({ coverageText: "..." });
    await tool("aggregate_term").execute({ key: "payment_terms_days", type: "vendor_supplier" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe(`/api/companies/${COMPANY}/contract-terms/payment_terms_days/aggregate`);
    expect(url.searchParams.get("report")).toBe("true");
    expect(url.searchParams.get("type")).toBe("vendor_supplier");
  });

  it("find_contract, find_related_contracts, search_contract_text and get_contract are plain reads", async () => {
    const fetchMock = stubFetch({ contracts: [] });
    await tool("find_contract").execute({ q: "warehouse lease", includeSuperseded: true });
    await tool("find_related_contracts").execute({ contractId: NEW_ID });
    await tool("search_contract_text").execute({ q: "free shipping", limit: 5 });
    await tool("get_contract").execute({ contractId: NEW_ID });
    await tool("list_contract_term_keys").execute({});
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${String(url).replace("http://localhost:3100/api", "")}`);
    expect(calls).toEqual([
      `GET /companies/${COMPANY}/contracts/find?q=warehouse+lease&includeSuperseded=true`,
      `GET /companies/${COMPANY}/contracts/${NEW_ID}/related`,
      `GET /companies/${COMPANY}/contracts/search-text?q=free+shipping&limit=5`,
      `GET /companies/${COMPANY}/contracts/${NEW_ID}`,
      `GET /companies/${COMPANY}/contract-terms`,
    ]);
  });

  it("set_contract_term writes one term and refuses an inconsistent one locally", async () => {
    const fetchMock = stubFetch({ key: "governing_law" });
    await tool("set_contract_term").execute({
      contractId: NEW_ID,
      key: "governing_law",
      valueKind: "text",
      textValue: "Norwegian law",
      clauseRef: "20.1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY}/contracts/${NEW_ID}/terms/governing_law`);
    expect((init as RequestInit).method).toBe("PUT");

    fetchMock.mockClear();
    const bad = await tool("set_contract_term").execute({ contractId: NEW_ID, key: "governing_law", valueKind: "number" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bad.content[0]!.text).toContain("error");
  });
});
