/**
 * What a Board chat run on a signed-in Paperclip may ask for, and how each
 * change is described to the person in plain words.
 *
 * Board chat acts as the signed-in person, inside one company. This module is
 * the written-down list of what it may touch:
 *
 *   * READS (GET) are allowed on the ordinary company API, except a short list
 *     of places that hold keys, sign-in, money or the whole instance.
 *   * WRITES are DEFAULT-DENY. Only the changes in WRITE_RULES below can even
 *     be held for approval; anything else is refused with a plain sentence
 *     telling the person to use the page in Paperclip themselves. A held
 *     change is never made until the person clicks Approve.
 *   * Deploy and merge cards (and every other card that moves money, code or
 *     keys) can never be decided from the chat.
 *
 * Pure apart from the injected `lookup`, so every rule can be tested directly.
 */

export const BOARD_CHAT_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type BoardChatDecision = { allowed: true } | { allowed: false; message: string; code: string };

export interface BoardChatActionDescription {
  summary: string;
  details: Array<{ label: string; value: string }>;
}

export type BoardChatWriteDecision =
  | ({ allowed: true; kind: BoardChatWriteKind } & BoardChatActionDescription)
  | { allowed: false; message: string; code: string };

/** Entities the policy looks up to check they are in this company and to name them. */
export interface BoardChatPolicyLookup {
  issue(id: string): Promise<{ companyId: string; identifier: string | null; title: string } | null>;
  agent(id: string): Promise<{ companyId: string; name: string } | null>;
  approval(id: string): Promise<{ companyId: string; type: string; payload: Record<string, unknown> | null } | null>;
  goal(id: string): Promise<{ companyId: string; title: string } | null>;
  project(id: string): Promise<{ companyId: string; name: string } | null>;
}

const UUID = "[0-9a-fA-F-]{36}";
const ANY_ID = "[^/]+";

/** Places Board chat may not read or change at all, whatever the method. */
const DENIED_PREFIXES: Array<{ prefix: RegExp; message: string }> = [
  { prefix: /^\/api\/(auth|cli-auth|board-claim|invites)(\/|$)/, message: "Board chat can't touch sign-in or invitations." },
  { prefix: /^\/api\/(instance|admin)(\/|$)/, message: "Board chat can't see or change settings for the whole Paperclip." },
  { prefix: /^\/api\/board(\/|$)/, message: "Board chat can't approve or change its own requests." },
  { prefix: /^\/api\/(board-api-keys|board-delegate-tokens|service-tokens)(\/|$)/, message: "Board chat can't see or create access keys." },
  { prefix: /^\/api\/(secrets|secret-provider-configs)(\/|$)/, message: "Board chat can't see or change stored secrets." },
  { prefix: /^\/api\/mcp-tools\/oauth(\/|$)/, message: "Board chat can't connect tools for you." },
  { prefix: /^\/api\/(crypto-wallets|crypto|payment-cards|payment-notices|trading)(\/|$)/, message: "Board chat can't touch money, cards or wallets." },
  { prefix: /^\/api\/(deploy-runner|preview-environments|previews)(\/|$)/, message: "Board chat can't deploy or run previews." },
  { prefix: new RegExp(`^/api/agents/${ANY_ID}/keys(/|$)`), message: "Board chat can't see or create agent keys." },
  { prefix: new RegExp(`^/api/issues/${ANY_ID}/interactions(/|$)`), message: "Board chat can't answer cards on a task. Open the task and answer it yourself." },
];

/** Company sub-pages Board chat may not read or change. */
const DENIED_COMPANY_SECTIONS =
  /^(board-chat|secrets|service-tokens|members|memberships|invites|join-requests|access|crypto-wallets|crypto|payment-cards|trading|data-connections|connections|mail-accounts|telegram-bots|deploy-runner|cloud-upstreams|migration|export|import)(\/|$)/;

const NOT_SUPPORTED_MESSAGE =
  "Board chat can't make that kind of change. Use the page in Paperclip to do it yourself.";

export type BoardChatWriteKind =
  | "create_issue"
  | "create_subtask"
  | "update_issue"
  | "delete_issue"
  | "add_comment"
  | "write_document"
  | "hire_agent"
  | "update_agent"
  | "write_agent_instructions"
  | "wake_agent"
  | "pause_agent"
  | "resume_agent"
  | "decide_approval"
  | "comment_approval"
  | "update_company"
  | "create_goal"
  | "update_goal"
  | "create_project"
  | "update_project";

interface WriteRule {
  method: string;
  pattern: RegExp;
  kind: BoardChatWriteKind;
}

/** The only writes Board chat can ask for. Everything else is refused. */
const WRITE_RULES: WriteRule[] = [
  { method: "POST", pattern: new RegExp(`^/api/companies/(${UUID})/issues$`), kind: "create_issue" },
  { method: "POST", pattern: new RegExp(`^/api/issues/(${ANY_ID})/children$`), kind: "create_subtask" },
  { method: "PATCH", pattern: new RegExp(`^/api/issues/(${ANY_ID})$`), kind: "update_issue" },
  { method: "DELETE", pattern: new RegExp(`^/api/issues/(${ANY_ID})$`), kind: "delete_issue" },
  { method: "POST", pattern: new RegExp(`^/api/issues/(${ANY_ID})/comments$`), kind: "add_comment" },
  { method: "PUT", pattern: new RegExp(`^/api/issues/(${ANY_ID})/documents/([^/]+)$`), kind: "write_document" },
  { method: "POST", pattern: new RegExp(`^/api/companies/(${UUID})/agent-hires$`), kind: "hire_agent" },
  { method: "PATCH", pattern: new RegExp(`^/api/agents/(${ANY_ID})$`), kind: "update_agent" },
  { method: "PUT", pattern: new RegExp(`^/api/agents/(${ANY_ID})/instructions-bundle/file$`), kind: "write_agent_instructions" },
  { method: "POST", pattern: new RegExp(`^/api/agents/(${ANY_ID})/heartbeat/invoke$`), kind: "wake_agent" },
  { method: "POST", pattern: new RegExp(`^/api/agents/(${ANY_ID})/pause$`), kind: "pause_agent" },
  { method: "POST", pattern: new RegExp(`^/api/agents/(${ANY_ID})/resume$`), kind: "resume_agent" },
  { method: "POST", pattern: new RegExp(`^/api/approvals/(${ANY_ID})/(approve|reject|request-revision)$`), kind: "decide_approval" },
  { method: "POST", pattern: new RegExp(`^/api/approvals/(${ANY_ID})/comments$`), kind: "comment_approval" },
  { method: "PATCH", pattern: new RegExp(`^/api/companies/(${UUID})$`), kind: "update_company" },
  { method: "POST", pattern: new RegExp(`^/api/companies/(${UUID})/goals$`), kind: "create_goal" },
  { method: "PATCH", pattern: new RegExp(`^/api/goals/(${ANY_ID})$`), kind: "update_goal" },
  { method: "POST", pattern: new RegExp(`^/api/companies/(${UUID})/projects$`), kind: "create_project" },
  { method: "PATCH", pattern: new RegExp(`^/api/projects/(${ANY_ID})$`), kind: "update_project" },
];

/** Agent fields Board chat may change; anything else (how it runs, its keys, its permissions) stays on the agent page. */
const AGENT_UPDATE_FIELDS = new Set([
  "name",
  "title",
  "icon",
  "capabilities",
  "budgetMonthlyCents",
  "reportsTo",
  "runtimeConfig",
  "adapterConfig",
]);
/** adapterConfig keys Board chat may set when hiring or changing an agent. No command, env, args or flags. */
const AGENT_ADAPTER_CONFIG_FIELDS = new Set(["model", "effort", "cwd"]);
const COMPANY_UPDATE_FIELDS = new Set(["name", "description", "budgetMonthlyCents", "requireBoardApprovalForNewAgents"]);

/** Strip the query string and refuse anything that could step outside the path it names. */
export function normalizeBoardChatPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  const pathOnly = raw.split("?")[0]!.split("#")[0]!;
  if (!pathOnly.startsWith("/")) return null;
  if (/[\\]|%2e|%2f|%5c|\/\.{1,2}(\/|$)|\/\//i.test(pathOnly)) return null;
  return pathOnly.length > 1 ? pathOnly.replace(/\/+$/, "") : pathOnly;
}

function deny(message: string, code = "BOARD_CHAT_NOT_ALLOWED"): { allowed: false; message: string; code: string } {
  return { allowed: false, message, code };
}

/**
 * The first gate, for every request a Board chat run makes (read or write):
 * stay on the Paperclip API, stay out of the denied places, and stay inside
 * this one company.
 */
export function checkBoardChatPath(method: string, rawPath: string, companyId: string): BoardChatDecision {
  const path = normalizeBoardChatPath(rawPath);
  if (!path) return deny("That address isn't allowed in Board chat.");
  const upper = method.toUpperCase();
  if (path.startsWith("/llms/") || path === "/llms") {
    return BOARD_CHAT_SAFE_METHODS.has(upper) ? { allowed: true } : deny(NOT_SUPPORTED_MESSAGE);
  }
  if (!path.startsWith("/api/")) return deny("Board chat can only use the Paperclip API.");
  for (const rule of DENIED_PREFIXES) {
    if (rule.prefix.test(path)) return deny(rule.message);
  }
  const companyMatch = path.match(/^\/api\/companies(?:\/([^/]+))?(?:\/(.*))?$/);
  if (companyMatch) {
    const [, targetCompany, rest] = companyMatch;
    if (!targetCompany) {
      // GET /api/companies lists only the companies the credential carries, i.e. this one.
      return BOARD_CHAT_SAFE_METHODS.has(upper)
        ? { allowed: true }
        : deny("Board chat can't create or remove companies.");
    }
    if (targetCompany !== companyId) {
      return deny("Board chat can only see and change this company.", "BOARD_CHAT_OTHER_COMPANY");
    }
    if (rest && DENIED_COMPANY_SECTIONS.test(rest)) {
      return deny("Board chat can't see or change that part of the company. Use the page in Paperclip yourself.");
    }
  }
  return { allowed: true };
}

function humanizeKey(key: string): string {
  const special: Record<string, string> = {
    budgetMonthlyCents: "Monthly budget",
    requireBoardApprovalForNewAgents: "New agents need approval",
    assigneeAgentId: "Assigned to",
    reportsTo: "Reports to",
    adapterConfig: "How it runs",
    runtimeConfig: "Schedule",
    parentId: "Parent task",
    projectId: "Project",
    goalId: "Goal",
    decisionNote: "Note",
    body: "Text",
  };
  if (special[key]) return special[key]!;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const MAX_DETAIL_CHARS = 4000;

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && /cents$/i.test(key)) return `$${(value / 100).toFixed(2)}`;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number") text = String(value);
  else text = JSON.stringify(value, null, 1).replace(/\n\s*/g, " ");
  if (text.length > MAX_DETAIL_CHARS) {
    return `${text.slice(0, MAX_DETAIL_CHARS)}… (${text.length - MAX_DETAIL_CHARS} more characters)`;
  }
  return text;
}

async function bodyDetails(
  body: Record<string, unknown>,
  lookup: BoardChatPolicyLookup,
  companyId: string,
): Promise<Array<{ label: string; value: string }>> {
  const lines: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(body)) {
    if ((key === "assigneeAgentId" || key === "reportsTo") && typeof value === "string") {
      const agent = await lookup.agent(value);
      lines.push({ label: humanizeKey(key), value: agent && agent.companyId === companyId ? agent.name : value });
      continue;
    }
    if (key === "parentId" && typeof value === "string") {
      const issue = await lookup.issue(value);
      lines.push({ label: humanizeKey(key), value: issue && issue.companyId === companyId ? issueLabel(issue) : value });
      continue;
    }
    lines.push({ label: humanizeKey(key), value: formatValue(key, value) });
  }
  return lines;
}

function issueLabel(issue: { identifier: string | null; title: string }): string {
  return issue.identifier ? `${issue.identifier} "${issue.title}"` : `"${issue.title}"`;
}

function quote(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? `"${value.trim().slice(0, 200)}"` : fallback;
}

/**
 * Why Board chat may not decide this card, or null when it may. Deploy and
 * merge cards are always refused; so is every card kind that moves money,
 * code, keys or tool access. Only plain hire, strategy and yes/no cards pass.
 */
export function boardChatApprovalRefusal(approval: { type: string; payload: Record<string, unknown> | null }): string | null {
  const kind = typeof approval.payload?.kind === "string" ? approval.payload.kind : "";
  if (/deploy|merge|rollback|release/i.test(kind)) {
    return "Deploy and merge cards can't be decided in Board chat. Open the card in Paperclip and decide it yourself.";
  }
  if (approval.type === "hire_agent" || approval.type === "approve_ceo_strategy") return null;
  if (approval.type === "request_board_approval" && !kind) return null;
  return "Board chat can't decide this kind of card. Open it in Paperclip and decide it yourself.";
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function badAdapterConfigKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["adapterConfig"];
  return Object.keys(value as Record<string, unknown>).filter((key) => !AGENT_ADAPTER_CONFIG_FIELDS.has(key));
}

/**
 * The second gate, for writes only: is this one of the changes Board chat can
 * ask for, inside this company — and if so, the exact plain-words card text.
 */
export async function describeBoardChatWrite(input: {
  method: string;
  path: string;
  body: unknown;
  companyId: string;
  lookup: BoardChatPolicyLookup;
}): Promise<BoardChatWriteDecision> {
  const method = input.method.toUpperCase();
  const path = normalizeBoardChatPath(input.path);
  if (!path) return deny("That address isn't allowed in Board chat.");
  const pathDecision = checkBoardChatPath(method, path, input.companyId);
  if (!pathDecision.allowed) return pathDecision;
  const rule = WRITE_RULES.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (!rule) return deny(NOT_SUPPORTED_MESSAGE, "BOARD_CHAT_WRITE_NOT_SUPPORTED");
  const match = path.match(rule.pattern)!;
  const id = decodeURIComponent(match[1] ?? "");
  const body = asRecord(input.body);
  const { lookup, companyId } = input;
  const otherCompany = deny("That isn't in this company.", "BOARD_CHAT_OTHER_COMPANY");
  const notFound = deny("Board chat couldn't find that in this company.", "BOARD_CHAT_TARGET_NOT_FOUND");

  const withDetails = async (summary: string, detailBody: Record<string, unknown> = body): Promise<BoardChatWriteDecision> => ({
    allowed: true,
    kind: rule.kind,
    summary,
    details: await bodyDetails(detailBody, lookup, companyId),
  });

  type Refusal = { allowed: false; message: string; code: string };
  type IssueRow = NonNullable<Awaited<ReturnType<BoardChatPolicyLookup["issue"]>>>;
  type AgentRow = NonNullable<Awaited<ReturnType<BoardChatPolicyLookup["agent"]>>>;
  const loadIssue = async (): Promise<{ error: Refusal } | { issue: IssueRow }> => {
    const issue = await lookup.issue(id);
    if (!issue) return { error: notFound };
    if (issue.companyId !== companyId) return { error: otherCompany };
    return { issue };
  };
  const loadAgent = async (): Promise<{ error: Refusal } | { agent: AgentRow }> => {
    const agent = await lookup.agent(id);
    if (!agent) return { error: notFound };
    if (agent.companyId !== companyId) return { error: otherCompany };
    return { agent };
  };

  switch (rule.kind) {
    case "create_issue":
      return withDetails(`Create a new task ${quote(body.title, "")}`.trim());
    case "create_subtask": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      return withDetails(`Create a sub-task ${quote(body.title, "")} under ${issueLabel(found.issue)}`.replace("  ", " "));
    }
    case "update_issue": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      const keys = Object.keys(body);
      if (keys.length === 0) return deny("There is nothing to change.", "BOARD_CHAT_EMPTY_CHANGE");
      return withDetails(`Change task ${issueLabel(found.issue)}`);
    }
    case "delete_issue": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      return withDetails(`Delete task ${issueLabel(found.issue)}`);
    }
    case "add_comment": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      return withDetails(`Add a comment to task ${issueLabel(found.issue)}`);
    }
    case "write_document": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      const key = decodeURIComponent(match[2] ?? "");
      return withDetails(`Write the "${key}" document on task ${issueLabel(found.issue)}`);
    }
    case "hire_agent": {
      const bad = badAdapterConfigKeys(body.adapterConfig);
      if (bad.length > 0) {
        return deny(
          `Board chat can only choose the model, effort and working folder for a new agent (not ${bad.join(", ")}). Hire it on the Agents page to set more.`,
          "BOARD_CHAT_FIELD_NOT_ALLOWED",
        );
      }
      const role = typeof body.role === "string" && body.role ? ` as ${body.role}` : "";
      return withDetails(`Hire a new agent ${quote(body.name, "")}${role}`.replace("  ", " "));
    }
    case "update_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      const notAllowed = Object.keys(body).filter((key) => !AGENT_UPDATE_FIELDS.has(key));
      const badAdapter = badAdapterConfigKeys(body.adapterConfig);
      if (notAllowed.length > 0 || badAdapter.length > 0) {
        return deny(
          `Board chat can't change ${[...notAllowed, ...badAdapter.map((key) => `adapterConfig.${key}`)].join(", ")} for an agent. Change it on the agent's page yourself.`,
          "BOARD_CHAT_FIELD_NOT_ALLOWED",
        );
      }
      if (Object.keys(body).length === 0) return deny("There is nothing to change.", "BOARD_CHAT_EMPTY_CHANGE");
      return withDetails(`Change agent "${found.agent.name}"`);
    }
    case "write_agent_instructions": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return withDetails(`Rewrite the instructions file ${quote(body.path, "")} for agent "${found.agent.name}"`.replace("  ", " "));
    }
    case "wake_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return withDetails(`Start agent "${found.agent.name}" working now`);
    }
    case "pause_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return withDetails(`Pause agent "${found.agent.name}"`);
    }
    case "resume_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return withDetails(`Resume agent "${found.agent.name}"`);
    }
    case "decide_approval":
    case "comment_approval": {
      const approval = await lookup.approval(id);
      if (!approval) return notFound;
      if (approval.companyId !== companyId) return otherCompany;
      const refusal = boardChatApprovalRefusal(approval);
      if (refusal) return deny(refusal, "BOARD_CHAT_APPROVAL_NOT_ALLOWED");
      const title = describeApprovalTitle(approval);
      if (rule.kind === "comment_approval") return withDetails(`Add a comment to the card ${title}`);
      const verb = match[2] === "approve" ? "Approve" : match[2] === "reject" ? "Reject" : "Ask for changes to";
      return withDetails(`${verb} the card ${title}`);
    }
    case "update_company": {
      const notAllowed = Object.keys(body).filter((key) => !COMPANY_UPDATE_FIELDS.has(key));
      if (notAllowed.length > 0) {
        return deny(
          `Board chat can't change ${notAllowed.join(", ")} for the company. Use Company settings yourself.`,
          "BOARD_CHAT_FIELD_NOT_ALLOWED",
        );
      }
      if (Object.keys(body).length === 0) return deny("There is nothing to change.", "BOARD_CHAT_EMPTY_CHANGE");
      return withDetails("Change the company's settings");
    }
    case "create_goal":
      return withDetails(`Create a new goal ${quote(body.title, "")}`.trim());
    case "update_goal": {
      const goal = await lookup.goal(id);
      if (!goal) return notFound;
      if (goal.companyId !== companyId) return otherCompany;
      return withDetails(`Change goal "${goal.title}"`);
    }
    case "create_project":
      return withDetails(`Create a new project ${quote(body.name, "")}`.trim());
    case "update_project": {
      const project = await lookup.project(id);
      if (!project) return notFound;
      if (project.companyId !== companyId) return otherCompany;
      return withDetails(`Change project "${project.name}"`);
    }
  }
}

function describeApprovalTitle(approval: { type: string; payload: Record<string, unknown> | null }): string {
  const payload = approval.payload ?? {};
  const named = [payload.title, payload.name, payload.summary].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (named) return `"${named.trim().slice(0, 200)}"`;
  if (approval.type === "hire_agent") return "to hire a new agent";
  if (approval.type === "approve_ceo_strategy") return "for the CEO's strategy";
  return "waiting for a decision";
}

/** Key-order-independent JSON, so the replay on Approve can be compared with what was held. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
