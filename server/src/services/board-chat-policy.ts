/**
 * What a Board chat run on a signed-in Paperclip may ask for, and how each
 * change is described to the person in plain words.
 *
 * Board chat acts as the signed-in person, inside one company. Its tools
 * (board-chat-tools.ts) build every request themselves from typed arguments;
 * this module is the second, independent gate those requests pass through
 * (in the tool, in the guard, and again on Approve):
 *
 *   * Addresses must be lower-case and plain (no "..", no encoded slashes):
 *     Express matches routes case-insensitively, so a deny list is only
 *     trustworthy when the case cannot vary.
 *   * READS (GET) are allowed on the ordinary company API, except a list of
 *     places that hold keys, sign-in, people, money or the whole instance.
 *   * WRITES are DEFAULT-DENY: only the changes in WRITE_RULES can be held,
 *     each with a strict list of the fields it may carry. Anything else is
 *     refused with a plain sentence pointing to the page in Paperclip.
 *   * Deploy and merge cards (and every card that moves money, code or keys)
 *     can never be decided from the chat.
 *   * The card shows EVERY field that will be sent, with its real name and
 *     its full value. A change too long to show in full is refused.
 *
 * Pure apart from the injected `lookup`, so every rule can be tested directly.
 */

export const BOARD_CHAT_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The longest single value a card shows in full; a longer change is refused, never cut. */
export const BOARD_CHAT_MAX_VALUE_CHARS = 20_000;
/** The longest whole change a card shows in full. */
export const BOARD_CHAT_MAX_BODY_CHARS = 40_000;

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
  issue(id: string): Promise<{ id?: string; companyId: string; identifier: string | null; title: string } | null>;
  agent(id: string): Promise<{ companyId: string; name: string } | null>;
  approval(id: string): Promise<{ companyId: string; type: string; payload: Record<string, unknown> | null } | null>;
  goal(id: string): Promise<{ companyId: string; title: string } | null>;
  project(id: string): Promise<{ companyId: string; name: string } | null>;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ANY_SEGMENT = "[^/]+";

/** Places Board chat may not read or change at all, whatever the method. Matched against a lower-case path. */
const DENIED_PREFIXES: Array<{ prefix: RegExp; message: string }> = [
  { prefix: /^\/api\/(auth|cli-auth|board-claim|invites|join-requests)(\/|$)/, message: "Board chat can't touch sign-in or invitations." },
  { prefix: /^\/api\/(instance|admin|access|users|user-profiles)(\/|$)/, message: "Board chat can't see or change people or settings for the whole Paperclip." },
  { prefix: /^\/api\/board(\/|$)/, message: "Board chat can't approve or change its own requests." },
  { prefix: /^\/api\/(board-api-keys|board-delegate-tokens|service-tokens)(\/|$)/, message: "Board chat can't see or create access keys." },
  { prefix: /^\/api\/(secrets|secret-provider-configs)(\/|$)/, message: "Board chat can't see or change stored secrets." },
  { prefix: /^\/api\/(mcp-tools|api-tools|plugins|cloud-upstreams)(\/|$)/, message: "Board chat can't connect or change tools for you." },
  { prefix: /^\/api\/(crypto-wallets|crypto|payment-cards|payment-notices|trading)(\/|$)/, message: "Board chat can't touch money, cards or wallets." },
  { prefix: /^\/api\/(deploy-runner|preview-environments|previews)(\/|$)/, message: "Board chat can't deploy or run previews." },
  { prefix: /^\/api\/(mail-accounts|mail|telegram-bots|data-connections)(\/|$)/, message: "Board chat can't read mail, chats or connected data." },
  { prefix: new RegExp(`^/api/agents/${ANY_SEGMENT}/(keys|instructions-bundle)(/|$)`), message: "Board chat can't see an agent's keys or instruction files." },
  { prefix: new RegExp(`^/api/issues/${ANY_SEGMENT}/interactions(/|$)`), message: "Board chat can't answer cards on a task. Open the task and answer it yourself." },
];

/** Company sub-pages Board chat may not read or change. Matched against a lower-case path. */
const DENIED_COMPANY_SECTIONS =
  /^(board-chat|secrets|service-tokens|members|memberships|people|invites|join-requests|access|crypto-wallets|crypto|payment-cards|trading|data-connections|connections|mail-accounts|mail|telegram-bots|deploy-runner|cloud-upstreams|migration|export|import|helper|model-directory|api-tools|mcp-tools)(\/|$)/;

const NOT_SUPPORTED_MESSAGE =
  "Board chat can't make that kind of change. Use the page in Paperclip to do it yourself.";

export type BoardChatWriteKind =
  | "create_issue"
  | "update_issue"
  | "delete_issue"
  | "add_comment"
  | "hire_agent"
  | "update_agent"
  | "wake_agent"
  | "pause_agent"
  | "resume_agent"
  | "decide_approval"
  | "update_company"
  | "create_goal"
  | "create_project";

interface WriteRule {
  method: string;
  pattern: RegExp;
  kind: BoardChatWriteKind;
  /** The only top-level fields this change may carry. */
  fields: readonly string[];
}

/** adapterConfig keys Board chat may set when hiring or changing an agent. No command, env, args, folder or flags. */
export const BOARD_CHAT_AGENT_ADAPTER_CONFIG_FIELDS = ["model", "effort"] as const;
/** The agent kinds Board chat may hire: Paperclip's own CLI agents, nothing that runs a command of its own. */
export const BOARD_CHAT_HIRE_ADAPTER_TYPES = ["claude_local", "codex_local", "gemini_local"] as const;

/** The only writes Board chat can ask for, and the fields each may carry. Everything else is refused. */
const WRITE_RULES: WriteRule[] = [
  {
    method: "POST",
    pattern: new RegExp(`^/api/companies/(${UUID})/issues$`),
    kind: "create_issue",
    fields: ["title", "description", "status", "priority", "assigneeAgentId", "projectId", "goalId", "parentId"],
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/issues/(${UUID})$`),
    kind: "update_issue",
    fields: ["title", "description", "status", "priority", "assigneeAgentId"],
  },
  { method: "DELETE", pattern: new RegExp(`^/api/issues/(${UUID})$`), kind: "delete_issue", fields: [] },
  { method: "POST", pattern: new RegExp(`^/api/issues/(${UUID})/comments$`), kind: "add_comment", fields: ["body"] },
  {
    method: "POST",
    pattern: new RegExp(`^/api/companies/(${UUID})/agent-hires$`),
    kind: "hire_agent",
    fields: ["name", "role", "title", "icon", "capabilities", "reportsTo", "budgetMonthlyCents", "adapterType", "adapterConfig"],
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/agents/(${UUID})$`),
    kind: "update_agent",
    fields: ["name", "title", "icon", "capabilities", "reportsTo", "budgetMonthlyCents", "adapterConfig"],
  },
  { method: "POST", pattern: new RegExp(`^/api/agents/(${UUID})/heartbeat/invoke$`), kind: "wake_agent", fields: [] },
  { method: "POST", pattern: new RegExp(`^/api/agents/(${UUID})/pause$`), kind: "pause_agent", fields: [] },
  { method: "POST", pattern: new RegExp(`^/api/agents/(${UUID})/resume$`), kind: "resume_agent", fields: [] },
  {
    method: "POST",
    pattern: new RegExp(`^/api/approvals/(${UUID})/(approve|reject|request-revision)$`),
    kind: "decide_approval",
    fields: ["decisionNote"],
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/companies/(${UUID})$`),
    kind: "update_company",
    fields: ["name", "description", "budgetMonthlyCents"],
  },
  { method: "POST", pattern: new RegExp(`^/api/companies/(${UUID})/goals$`), kind: "create_goal", fields: ["title", "description"] },
  { method: "POST", pattern: new RegExp(`^/api/companies/(${UUID})/projects$`), kind: "create_project", fields: ["name", "description"] },
];

/**
 * Strip the query string and refuse anything that could step outside the
 * path it names, or that is not lower-case (Express would still match it).
 */
export function normalizeBoardChatPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  const pathOnly = raw.split("?")[0]!.split("#")[0]!;
  if (!pathOnly.startsWith("/")) return null;
  if (pathOnly !== pathOnly.toLowerCase()) return null;
  if (/[\\%;]|\/\.{1,2}(\/|$)|\/\//.test(pathOnly)) return null;
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
  void method;
  if (!path.startsWith("/api/")) return deny("Board chat can only use the Paperclip API.");
  for (const rule of DENIED_PREFIXES) {
    if (rule.prefix.test(path)) return deny(rule.message);
  }
  const companyMatch = path.match(/^\/api\/companies(?:\/([^/]+))?(?:\/(.*))?$/);
  if (companyMatch) {
    const [, targetCompany, rest] = companyMatch;
    if (!targetCompany) return deny("Board chat can only see and change this company.", "BOARD_CHAT_OTHER_COMPANY");
    if (targetCompany !== companyId.toLowerCase()) {
      return deny("Board chat can only see and change this company.", "BOARD_CHAT_OTHER_COMPANY");
    }
    if (rest && DENIED_COMPANY_SECTIONS.test(rest)) {
      return deny("Board chat can't see or change that part of the company. Use the page in Paperclip yourself.");
    }
  }
  return { allowed: true };
}

/** The real name of every field a card can show. Unknown names never reach a card (the field lists refuse them). */
const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  assigneeAgentId: "Assigned to",
  projectId: "Project",
  goalId: "Goal",
  parentId: "Parent task",
  body: "Comment",
  name: "Name",
  role: "Role",
  icon: "Icon",
  capabilities: "What it does",
  reportsTo: "Reports to",
  budgetMonthlyCents: "Monthly budget",
  adapterType: "Agent kind",
  "adapterConfig.model": "Model",
  "adapterConfig.effort": "Effort",
  decisionNote: "Note",
};

function formatScalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && /cents$/i.test(key)) return `$${(value / 100).toFixed(2)}`;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function issueLabel(issue: { identifier: string | null; title: string }): string {
  return issue.identifier ? `${issue.identifier} "${issue.title}"` : `"${issue.title}"`;
}

function quote(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? `"${value.trim().slice(0, 200)}"` : fallback;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return Math.max(0, ...value.map(longestString));
  if (value && typeof value === "object") return Math.max(0, ...Object.values(value).map(longestString));
  return 0;
}

/**
 * Why Board chat may not decide this card, or null when it may. Deploy and
 * merge cards are always refused; so is every card kind that moves money,
 * code, keys or tool access. Only hire and strategy cards pass: plain yes/no
 * cards are also used for spending and publishing, so they stay on the page.
 */
export function boardChatApprovalRefusal(approval: { type: string; payload: Record<string, unknown> | null }): string | null {
  const kind = typeof approval.payload?.kind === "string" ? approval.payload.kind : "";
  if (/deploy|merge|rollback|release/i.test(kind)) {
    return "Deploy and merge cards can't be decided in Board chat. Open the card in Paperclip and decide it yourself.";
  }
  if (approval.type === "hire_agent" || approval.type === "approve_ceo_strategy") return null;
  return "Board chat can't decide this kind of card. Open it in Paperclip and decide it yourself.";
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (body === null || body === undefined) return {};
  return typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * The second gate, for writes only: is this one of the changes Board chat can
 * ask for, inside this company, carrying only allowed fields — and if so, the
 * exact plain-words card text with every field and its full value.
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
  if (input.path.includes("?")) return deny(NOT_SUPPORTED_MESSAGE, "BOARD_CHAT_WRITE_NOT_SUPPORTED");
  const pathDecision = checkBoardChatPath(method, path, input.companyId);
  if (!pathDecision.allowed) return pathDecision;
  const rule = WRITE_RULES.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (!rule) return deny(NOT_SUPPORTED_MESSAGE, "BOARD_CHAT_WRITE_NOT_SUPPORTED");
  const match = path.match(rule.pattern)!;
  const id = match[1] ?? "";
  const body = asRecord(input.body);
  if (!body) return deny("That change isn't in a form Board chat can show.", "BOARD_CHAT_NOT_ALLOWED");
  const { lookup, companyId } = input;
  const otherCompany = deny("That isn't in this company.", "BOARD_CHAT_OTHER_COMPANY");
  const notFound = deny("Board chat couldn't find that in this company.", "BOARD_CHAT_TARGET_NOT_FOUND");

  // Only the fields this kind of change may carry.
  const extra = Object.keys(body).filter((key) => !rule.fields.includes(key));
  if (extra.length > 0) {
    return deny(
      `Board chat can't change ${extra.join(", ")} here. Use the page in Paperclip to do that yourself.`,
      "BOARD_CHAT_FIELD_NOT_ALLOWED",
    );
  }
  if ("adapterConfig" in body) {
    const config = body.adapterConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return deny("Board chat can only choose an agent's model and effort.", "BOARD_CHAT_FIELD_NOT_ALLOWED");
    }
    const bad = Object.keys(config).filter((key) => !(BOARD_CHAT_AGENT_ADAPTER_CONFIG_FIELDS as readonly string[]).includes(key));
    const nonScalar = Object.values(config).some((value) => value !== null && typeof value === "object");
    if (bad.length > 0 || nonScalar) {
      return deny(
        `Board chat can only choose an agent's model and effort (not ${bad.join(", ") || "nested settings"}). Change the rest on the agent's page yourself.`,
        "BOARD_CHAT_FIELD_NOT_ALLOWED",
      );
    }
  }
  for (const [key, value] of Object.entries(body)) {
    if (key !== "adapterConfig" && value !== null && typeof value === "object") {
      return deny(`Board chat can't send ${key} in that form.`, "BOARD_CHAT_FIELD_NOT_ALLOWED");
    }
  }
  if (longestString(body) > BOARD_CHAT_MAX_VALUE_CHARS || JSON.stringify(body).length > BOARD_CHAT_MAX_BODY_CHARS) {
    return deny(
      "That change is too long to show in full on a card, so Board chat won't prepare it. Make it on the page in Paperclip yourself.",
      "BOARD_CHAT_CHANGE_TOO_LONG",
    );
  }

  // Every referenced thing must be in this company; the card shows its name.
  const lines: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "adapterConfig") {
      for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
        lines.push({ label: FIELD_LABELS[`adapterConfig.${sub}`] ?? `adapterConfig.${sub}`, value: formatScalar(sub, subValue) });
      }
      continue;
    }
    const label = FIELD_LABELS[key] ?? key;
    if ((key === "assigneeAgentId" || key === "reportsTo") && typeof value === "string") {
      const agent = await lookup.agent(value);
      if (!agent) return notFound;
      if (agent.companyId !== companyId) return otherCompany;
      lines.push({ label, value: agent.name });
      continue;
    }
    if (key === "parentId" && typeof value === "string") {
      const issue = await lookup.issue(value);
      if (!issue) return notFound;
      if (issue.companyId !== companyId) return otherCompany;
      lines.push({ label, value: issueLabel(issue) });
      continue;
    }
    if (key === "projectId" && typeof value === "string") {
      const project = await lookup.project(value);
      if (!project) return notFound;
      if (project.companyId !== companyId) return otherCompany;
      lines.push({ label, value: project.name });
      continue;
    }
    if (key === "goalId" && typeof value === "string") {
      const goal = await lookup.goal(value);
      if (!goal) return notFound;
      if (goal.companyId !== companyId) return otherCompany;
      lines.push({ label, value: goal.title });
      continue;
    }
    if (key === "adapterType" && !(BOARD_CHAT_HIRE_ADAPTER_TYPES as readonly string[]).includes(String(value))) {
      return deny("Board chat can only hire Paperclip's own Claude, Codex or Gemini agents.", "BOARD_CHAT_FIELD_NOT_ALLOWED");
    }
    lines.push({ label, value: formatScalar(key, value) });
  }

  const allowed = (summary: string): BoardChatWriteDecision => ({ allowed: true, kind: rule.kind, summary, details: lines });

  const loadIssue = async (): Promise<{ error: ReturnType<typeof deny> } | { issue: { identifier: string | null; title: string } }> => {
    const issue = await lookup.issue(id);
    if (!issue) return { error: notFound };
    if (issue.companyId !== companyId) return { error: otherCompany };
    return { issue };
  };
  const loadAgent = async (): Promise<{ error: ReturnType<typeof deny> } | { agent: { name: string } }> => {
    const agent = await lookup.agent(id);
    if (!agent) return { error: notFound };
    if (agent.companyId !== companyId) return { error: otherCompany };
    return { agent };
  };
  const requireSomething = () => (Object.keys(body).length === 0 ? deny("There is nothing to change.", "BOARD_CHAT_EMPTY_CHANGE") : null);

  switch (rule.kind) {
    case "create_issue":
      if (typeof body.title !== "string" || !body.title.trim()) return deny("A new task needs a title.", "BOARD_CHAT_EMPTY_CHANGE");
      return allowed(`Create a new task ${quote(body.title, "")}`.trim());
    case "update_issue": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      return requireSomething() ?? allowed(`Change task ${issueLabel(found.issue)}`);
    }
    case "delete_issue": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      return allowed(`Delete task ${issueLabel(found.issue)}`);
    }
    case "add_comment": {
      const found = await loadIssue();
      if ("error" in found) return found.error;
      if (typeof body.body !== "string" || !body.body.trim()) return deny("A comment needs some text.", "BOARD_CHAT_EMPTY_CHANGE");
      return allowed(`Add a comment to task ${issueLabel(found.issue)}`);
    }
    case "hire_agent": {
      if (typeof body.name !== "string" || !body.name.trim()) return deny("A new agent needs a name.", "BOARD_CHAT_EMPTY_CHANGE");
      if (!body.adapterType) return deny("A new agent needs an agent kind.", "BOARD_CHAT_EMPTY_CHANGE");
      const role = typeof body.role === "string" && body.role ? ` as ${body.role}` : "";
      return allowed(`Hire a new agent ${quote(body.name, "")}${role}`);
    }
    case "update_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return requireSomething() ?? allowed(`Change agent "${found.agent.name}"`);
    }
    case "wake_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return allowed(`Start agent "${found.agent.name}" working now`);
    }
    case "pause_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return allowed(`Pause agent "${found.agent.name}"`);
    }
    case "resume_agent": {
      const found = await loadAgent();
      if ("error" in found) return found.error;
      return allowed(`Resume agent "${found.agent.name}"`);
    }
    case "decide_approval": {
      const approval = await lookup.approval(id);
      if (!approval) return notFound;
      if (approval.companyId !== companyId) return otherCompany;
      const refusal = boardChatApprovalRefusal(approval);
      if (refusal) return deny(refusal, "BOARD_CHAT_APPROVAL_NOT_ALLOWED");
      const verb = match[2] === "approve" ? "Approve" : match[2] === "reject" ? "Reject" : "Ask for changes to";
      return allowed(`${verb} the card ${describeApprovalTitle(approval)}`);
    }
    case "update_company":
      if (match[1] !== companyId.toLowerCase()) return otherCompany;
      return requireSomething() ?? allowed("Change the company's settings");
    case "create_goal":
      if (typeof body.title !== "string" || !body.title.trim()) return deny("A new goal needs a title.", "BOARD_CHAT_EMPTY_CHANGE");
      return allowed(`Create a new goal ${quote(body.title, "")}`.trim());
    case "create_project":
      if (typeof body.name !== "string" || !body.name.trim()) return deny("A new project needs a name.", "BOARD_CHAT_EMPTY_CHANGE");
      return allowed(`Create a new project ${quote(body.name, "")}`.trim());
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

/** Key-order-independent JSON, so the request made on Approve can be compared with what was held. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
