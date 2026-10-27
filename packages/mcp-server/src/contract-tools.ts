/**
 * Contract register tools for the Legal Advisor (Legal Phase 4, DUR-4856).
 *
 * Like the wallet and browser tools, this file holds no secret and makes no
 * decision: every tool is a direct pass-through to one
 * `/api/companies/:companyId/contract...` call made with the agent's own run
 * token, always for the agent's own company. The server decides who may use
 * the register (board, the Legal Advisor position, or an explicit
 * `contracts:access` grant), keeps contract text out of every other agent's
 * hands, and refuses to link a contract version unless a board member accepted
 * a confirmation for that exact pair. Nothing here can approve anything.
 */
import { z } from "zod";
import {
  contractTermKeySchema,
  contractTermValueShape,
  contractVersionLinkConfirmationKey,
  registerContractObjectSchema,
  upsertContractTermSchema,
  CONTRACT_TYPES,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import type { ToolDefinition } from "./tools.js";

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

const contractId = z.string().uuid().describe("The contract's id, from register_contract or find_contract");
const contractTypeSchema = z.enum(CONTRACT_TYPES);
const companyIdOptional = z.string().uuid().optional().nullable();

export const CONTRACT_TOOL_NAMES = [
  "register_contract",
  "get_contract",
  "find_contract",
  "find_related_contracts",
  "link_contract_version",
  "set_contract_term",
  "list_contract_term_keys",
  "aggregate_term",
  "search_contract_text",
] as const;

export function createContractToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  const enc = encodeURIComponent;
  const base = (companyId?: string | null) => `/companies/${client.resolveCompanyId(companyId)}`;
  const query = (params: Record<string, string | number | boolean | undefined | null>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  };

  return [
    makeTool(
      "register_contract",
      "Write a contract into the register in one step: the contract itself, its parties, the terms it states (each with a clause or page reference) and its deadlines. All of it is saved or none of it. Fields you could not read with confidence must not be guessed: leave them out and ask the owner with paperclipAskUserQuestions. Use valueKind not_mentioned or explicitly_none for a term the contract was read for and does not state; never invent a number.",
      z.object({ companyId: companyIdOptional, ...registerContractObjectSchema.shape }),
      async ({ companyId, ...body }) => client.requestJson("POST", `${base(companyId)}/contracts/register`, { body }),
    ),
    makeTool(
      "get_contract",
      "Read one contract from the register: its fields, parties, deadlines and terms. The full extracted text is only returned if includeText is true; ask for it only when you must quote a clause.",
      z.object({ companyId: companyIdOptional, contractId, includeText: z.boolean().optional() }),
      async ({ companyId, contractId: id, includeText }) =>
        client.requestJson("GET", `${base(companyId)}/contracts/${enc(id)}${query({ includeText })}`),
    ),
    makeTool(
      "find_contract",
      "Find a contract by title, party name or type, even with a small typo. Returns the best matches with a summary, the parties, and a link to the stored file (file.contentPath) to attach in your answer. Replaced versions are left out unless includeSuperseded is true.",
      z.object({
        companyId: companyIdOptional,
        q: z.string().trim().min(1).max(200).optional().describe("Words from the title, a party name or the summary"),
        type: contractTypeSchema.optional(),
        party: z.string().trim().min(1).max(200).optional().describe("Part of a party name"),
        includeSuperseded: z.boolean().optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      async ({ companyId, ...params }) => client.requestJson("GET", `${base(companyId)}/contracts/find${query(params)}`),
    ),
    makeTool(
      "find_related_contracts",
      "List older contracts that this one might be a renegotiated version of: same type and same parties, or named in this contract's own text. These are candidates only. Never link them yourself: ask the owner with paperclipRequestConfirmation first (see link_contract_version).",
      z.object({ companyId: companyIdOptional, contractId }),
      async ({ companyId, contractId: id }) => client.requestJson("GET", `${base(companyId)}/contracts/${enc(id)}/related`),
    ),
    makeTool(
      "link_contract_version",
      "Make a contract the newer version of an older one: marks the old one superseded, numbers the new one, stores your 'what changed' comparison, and either carries the old open deadlines over or closes them. The server refuses unless a board member ACCEPTED a request_confirmation for exactly this pair. Create that confirmation first with paperclipRequestConfirmation, using target {\"type\":\"custom\",\"key\":\"<confirmationTargetKey>\"} (call this tool with dryRun=true to get the key), wait for the owner to accept, then pass the confirmation's id as confirmationInteractionId.",
      z.object({
        companyId: companyIdOptional,
        contractId: z.string().uuid().describe("The NEW contract"),
        previousContractId: z.string().uuid().describe("The OLD contract it replaces"),
        changeSummary: z.string().trim().min(1).max(5000).describe("What changed from the old version to the new one, clause by clause"),
        carryDeadlines: z.boolean().describe("true: move the old open deadlines to the new version; false: close them as superseded"),
        confirmationInteractionId: z.string().uuid().optional().describe("The id of the accepted request_confirmation"),
        dryRun: z.boolean().optional().describe("true: only return the target key the confirmation must carry; changes nothing"),
      }),
      async ({ companyId, contractId: id, previousContractId, changeSummary, carryDeadlines, confirmationInteractionId, dryRun }) => {
        const confirmationTargetKey = contractVersionLinkConfirmationKey(id, previousContractId);
        if (dryRun) return { dryRun: true, confirmationTargetKey };
        return client.requestJson("POST", `${base(companyId)}/contracts/${enc(id)}/link-previous-version`, {
          body: { previousContractId, changeSummary, carryDeadlines, confirmationInteractionId },
        });
      },
    ),
    makeTool(
      "set_contract_term",
      "Record or correct one term on a contract (a number with currency, a text, a yes/no, 'not_mentioned' or 'explicitly_none'), with the clause and page it comes from.",
      z.object({ companyId: companyIdOptional, contractId, key: contractTermKeySchema, ...contractTermValueShape }),
      async ({ companyId, contractId: id, key, ...term }) => {
        // Same value rules as the register itself, checked before the call so the error is local and clear.
        const parsed = upsertContractTermSchema.parse(term);
        return client.requestJson("PUT", `${base(companyId)}/contracts/${enc(id)}/terms/${enc(key)}`, { body: parsed });
      },
    ),
    makeTool(
      "list_contract_term_keys",
      "List the term keys the register knows (the standard ones plus any in use), so questions across contracts use the same spelling.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `${base(companyId)}/contract-terms`),
    ),
    makeTool(
      "aggregate_term",
      "Answer a question about one term across all contracts (for example the average free-shipping threshold). Returns the figures AND the coverage: how many contracts have a value, how many do not mention it, how many state there is none, how many nothing was recorded for, each with the contract titles and clause references. Quote the coverage with every number. Contracts that do not state a value are never averaged. Replaced versions are not counted.",
      z.object({
        companyId: companyIdOptional,
        key: contractTermKeySchema,
        type: contractTypeSchema.optional(),
        partyOrganizationId: z.string().uuid().optional(),
        statuses: z.string().max(200).optional().describe("Comma separated contract statuses; default is all except superseded"),
      }),
      async ({ companyId, key, ...params }) =>
        client.requestJson("GET", `${base(companyId)}/contract-terms/${enc(key)}/aggregate${query({ ...params, report: "true" })}`),
    ),
    makeTool(
      "search_contract_text",
      "Search the extracted text of the contracts for a word or phrase and get short snippets back. Use it after aggregate_term, for what the structured terms do not cover. The answer also says how many contracts have no readable text yet; a contract without text cannot match, so say so instead of reporting 'not mentioned'.",
      z.object({
        companyId: companyIdOptional,
        q: z.string().trim().min(2).max(200),
        type: contractTypeSchema.optional(),
        statuses: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      async ({ companyId, ...params }) => client.requestJson("GET", `${base(companyId)}/contracts/search-text${query(params)}`),
    ),
  ];
}
