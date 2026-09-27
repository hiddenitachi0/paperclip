import { and, count, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyApiToolCalls, companyApiTools, companySecretBindings } from "@paperclipai/db";
import {
  apiToolActionSchema,
  apiToolAuthSchema,
  normalizeApiToolBaseUrl,
  type ApiToolAction,
  type ApiToolAuth,
  type ApiToolBody,
  type ApiToolUpdate,
} from "@paperclipai/shared/validators/api-tool";
import { HttpError, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { redactKnownLeakedSecretPatterns, redactKnownSecretValues } from "../redaction.js";
import { secretService } from "./secrets.js";
import {
  createSafeOutboundFetch,
  SafeOutboundFetchError,
  type OutboundHostPolicy,
  type SafeOutboundFetchDeps,
} from "./safe-outbound-fetch.js";

/**
 * DUR-4004: "API with a key" tools -- a service that hands out an API key and
 * a plain HTTP API, added once on the Tools page and then ticked on per
 * agent, exactly like an MCP server from the tool library.
 *
 * The one rule this file exists to enforce: the key is a credential. It lives
 * in the company secret store, is bound to the tool row in
 * company_secret_bindings (target_type 'api_tool', config_path 'auth'), and
 * is read back in exactly one place -- `resolveKey` -- which is only ever
 * called by code in this file that makes the outbound call itself. No
 * function here returns the key to a caller, `toSummary` (the shape every
 * route answers with) has no field it could travel in, and every text that
 * leaves this file (response body, error sentence, the list of links) is
 * scrubbed of the key and of anything key-shaped first.
 *
 * Every outbound call goes through the same guard the business-data
 * connections use (public https only, the tool's own host only, no
 * redirects, 30 s, 2 MB), and is written to company_api_tool_calls, which is
 * both the audit trail and the counter the tool's daily cap is enforced from.
 */

export const API_TOOL_CREDENTIAL_CONFIG_PATH = "auth";
export const API_TOOL_REQUEST_TIMEOUT_MS = 30_000;
export const API_TOOL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Body text handed back to a caller is cut here, with a note. */
export const API_TOOL_BODY_TEXT_LIMIT = 50 * 1024;
export const API_TOOL_MAX_URLS = 50;

const KEY_RE = /^[a-z0-9-]{1,64}$/;

export type ApiToolRow = typeof companyApiTools.$inferSelect;

export type ApiToolChannel = "quick_chat" | "agent_run" | "board" | "settings_test";

export interface ApiToolCaller {
  channel: ApiToolChannel;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
}

export interface ApiToolSummary {
  id: string;
  companyId: string;
  name: string;
  key: string;
  description: string;
  baseUrl: string;
  auth: ApiToolAuth | null;
  actions: ApiToolAction[];
  openapiUrl: string | null;
  dailyCap: number;
  status: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiToolRunResult {
  /** True for a 2xx answer. */
  ok: boolean;
  /** The HTTP status, or 0 when no answer came back (refused, timed out, unreachable). */
  status: number;
  contentType: string | null;
  /** The answer as text (JSON pretty-printed), cut at API_TOOL_BODY_TEXT_LIMIT with a note. */
  body: string;
  truncated: boolean;
  /** Every http(s) link found in the answer, in order, at most API_TOOL_MAX_URLS. */
  urls: string[];
  /** A plain sentence when the call did not get an answer, else null. */
  error: string | null;
  durationMs: number;
}

export interface ApiToolTestResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface ApiToolServiceDeps extends SafeOutboundFetchDeps {
  now?: () => number;
}

function deriveKey(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return KEY_RE.test(slug) && slug.length > 0 ? slug : "api";
}

function utcDayStart(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Everything a stored tool needs to make one call, as a policy for the guard. */
export function createApiToolOutboundPolicy(baseUrl: string): OutboundHostPolicy {
  const normalized = normalizeApiToolBaseUrl(baseUrl);
  if (!normalized.ok) throw new SafeOutboundFetchError("host_not_allowed", normalized.message);
  const escaped = normalized.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    sourceKind: "api_tool",
    protocols: ["https:"],
    hostPattern: new RegExp(`^${escaped}$`),
    timeoutMs: API_TOOL_REQUEST_TIMEOUT_MS,
    maxResponseBytes: API_TOOL_MAX_RESPONSE_BYTES,
  };
}

// `key=`, `api_key=`, `token=` and friends inside a URL or a query string:
// the guard's own pattern list covers vendor-shaped keys (sk-..., ghp_...),
// this covers a key that is only recognisable by the parameter it rides in.
const QUERY_KEY_RE = /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|secret|password)=)[^&\s"'<>]+/gi;

/** Removes the key (when known), key-shaped text, and `key=...` query values from any text that leaves this file. */
export function scrubApiToolText(text: string, knownSecrets: Iterable<string>): string {
  return redactKnownSecretValues(redactKnownLeakedSecretPatterns(text), knownSecrets).replace(QUERY_KEY_RE, "$1[REDACTED]");
}

const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/g;

export function findUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (!seen.has(url)) seen.add(url);
    if (seen.size >= API_TOOL_MAX_URLS) break;
  }
  return [...seen];
}

function describeInputs(action: ApiToolAction): string {
  return action.inputs.length === 0 ? "no inputs" : action.inputs.map((input) => input.name).join(", ");
}

/**
 * Checks a caller's input against the action's declared inputs. Scalars are
 * coerced the way a model tends to send them (a number as "3", a boolean as
 * "true"); anything else is refused with a plain sentence. Returns the
 * cleaned input.
 */
export function validateActionInput(action: ApiToolAction, raw: Record<string, unknown>): Record<string, unknown> {
  const declared = new Map(action.inputs.map((input) => [input.name, input]));
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) {
      throw unprocessable(`Unknown input "${key}". The action "${action.name}" takes: ${describeInputs(action)}.`, { code: "unknown_input" });
    }
  }
  for (const input of action.inputs) {
    const value = raw[input.name];
    if (value === undefined || value === null || value === "") {
      if (input.required) {
        throw unprocessable(`Missing required input "${input.name}" for the action "${action.name}".`, { code: "missing_input" });
      }
      continue;
    }
    switch (input.type) {
      case "string":
        if (typeof value === "string") cleaned[input.name] = value;
        else if (typeof value === "number" || typeof value === "boolean") cleaned[input.name] = String(value);
        else throw unprocessable(`The input "${input.name}" must be text.`, { code: "bad_input" });
        break;
      case "number":
      case "integer": {
        const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
        if (!Number.isFinite(parsed)) throw unprocessable(`The input "${input.name}" must be a number.`, { code: "bad_input" });
        if (input.type === "integer" && !Number.isInteger(parsed)) {
          throw unprocessable(`The input "${input.name}" must be a whole number.`, { code: "bad_input" });
        }
        cleaned[input.name] = parsed;
        break;
      }
      case "boolean":
        if (typeof value === "boolean") cleaned[input.name] = value;
        else if (value === "true" || value === "false") cleaned[input.name] = value === "true";
        else throw unprocessable(`The input "${input.name}" must be true or false.`, { code: "bad_input" });
        break;
      case "json":
        if (typeof value === "object") cleaned[input.name] = value;
        else if (typeof value === "string") {
          try {
            cleaned[input.name] = JSON.parse(value);
          } catch {
            throw unprocessable(`The input "${input.name}" must be JSON (an object or a list).`, { code: "bad_input" });
          }
        } else throw unprocessable(`The input "${input.name}" must be JSON (an object or a list).`, { code: "bad_input" });
        break;
    }
  }
  return cleaned;
}

export interface BuiltApiToolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * The exact request-building rules, in one place:
 *  1. `{name}` placeholders in the path are filled from the input of that
 *     name (URL-encoded) and those inputs are consumed.
 *  2. Every other input goes to the query string for GET and DELETE, and to
 *     a JSON object body for POST, PUT and PATCH. A `json`-typed input is sent
 *     as its JSON text in a query string and as the value itself in a body.
 *  3. The key is attached last: `Authorization: Bearer <key>` (bearer),
 *     `<name>: <prefix><key>` (header) or `?<name>=<key>` (query).
 * The base address and the path are joined with exactly one slash.
 */
export function buildApiToolRequest(
  baseUrl: string,
  auth: ApiToolAuth,
  action: Pick<ApiToolAction, "method" | "path" | "inputs">,
  input: Record<string, unknown>,
  key: string,
): BuiltApiToolRequest {
  const remaining = { ...input };
  const path = action.path.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = remaining[name];
    delete remaining[name];
    return encodeURIComponent(value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
  });
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  const headers: Record<string, string> = { accept: "application/json, text/*;q=0.8, */*;q=0.5", "user-agent": "Paperclip-api-tool/1.0" };
  let body: string | undefined;
  const sendsBody = action.method === "POST" || action.method === "PUT" || action.method === "PATCH";
  if (sendsBody) {
    if (Object.keys(remaining).length > 0) {
      body = JSON.stringify(remaining);
      headers["content-type"] = "application/json";
    }
  } else {
    for (const [name, value] of Object.entries(remaining)) {
      url.searchParams.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  switch (auth.kind) {
    case "bearer":
      headers.authorization = `Bearer ${key}`;
      break;
    case "header":
      headers[(auth.name ?? "Authorization").toLowerCase()] = `${auth.prefix ?? ""}${key}`;
      break;
    case "query":
      url.searchParams.set(auth.name ?? "api_key", key);
      break;
  }
  return { url: url.toString(), method: action.method, headers, body };
}

function prettyBody(text: string, contentType: string | null): string {
  const looksJson = (contentType ?? "").includes("json") || /^\s*[[{]/.test(text);
  if (!looksJson) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the service";
  }
}

export function apiToolService(db: Db, deps: ApiToolServiceDeps = {}) {
  const secrets = secretService(db);
  const now = deps.now ?? (() => Date.now());

  function parseAuth(row: Pick<ApiToolRow, "auth">): ApiToolAuth | null {
    const parsed = apiToolAuthSchema.safeParse(row.auth);
    return parsed.success ? parsed.data : null;
  }

  function parseActions(row: Pick<ApiToolRow, "actions">): ApiToolAction[] {
    const raw = Array.isArray(row.actions) ? row.actions : [];
    const actions: ApiToolAction[] = [];
    for (const entry of raw) {
      const parsed = apiToolActionSchema.safeParse(entry);
      if (parsed.success) actions.push(parsed.data);
    }
    return actions;
  }

  function toSummary(row: ApiToolRow): ApiToolSummary {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      key: row.key,
      description: row.description,
      baseUrl: row.baseUrl,
      auth: parseAuth(row),
      actions: parseActions(row),
      openapiUrl: row.openapiUrl ?? null,
      dailyCap: row.dailyCap,
      status: row.status,
      lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
      lastTestOk: row.lastTestOk ?? null,
      lastTestMessage: row.lastTestMessage ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function getRow(companyId: string, toolId: string): Promise<ApiToolRow> {
    const [row] = await db
      .select()
      .from(companyApiTools)
      .where(and(eq(companyApiTools.companyId, companyId), eq(companyApiTools.id, toolId)));
    if (!row) throw notFound("Tool not found");
    return row;
  }

  async function uniqueKey(companyId: string, wanted: string, excludeId?: string): Promise<string> {
    const rows = await db
      .select({ id: companyApiTools.id, key: companyApiTools.key })
      .from(companyApiTools)
      .where(and(eq(companyApiTools.companyId, companyId), eq(companyApiTools.key, wanted)));
    const taken = rows.some((row) => row.id !== excludeId);
    return taken ? `${wanted.slice(0, 56)}-${now().toString(36)}` : wanted;
  }

  async function bindKey(companyId: string, toolId: string, auth: ApiToolAuth, label: string) {
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "api_tool", targetId: toolId },
      [{ secretId: auth.secretId, configPath: API_TOOL_CREDENTIAL_CONFIG_PATH, label: `API tool: ${label}` }],
      { replaceAll: true },
    );
  }

  async function create(companyId: string, input: ApiToolBody, actor: { userId: string | null }): Promise<ApiToolSummary> {
    const normalized = normalizeApiToolBaseUrl(input.baseUrl);
    if (!normalized.ok) throw unprocessable(normalized.message);
    const key = await uniqueKey(companyId, deriveKey(input.name));
    const [row] = await db
      .insert(companyApiTools)
      .values({
        companyId,
        name: input.name,
        key,
        description: input.description,
        baseUrl: normalized.url,
        auth: input.auth,
        actions: input.actions,
        openapiUrl: input.openapiUrl ?? null,
        dailyCap: input.dailyCap,
        status: input.status,
        createdByUserId: actor.userId,
      })
      .returning();
    try {
      await bindKey(companyId, row!.id, input.auth, input.name);
    } catch (error) {
      await db.delete(companyApiTools).where(eq(companyApiTools.id, row!.id)).catch(() => undefined);
      throw error;
    }
    return toSummary(row!);
  }

  async function update(companyId: string, toolId: string, patch: ApiToolUpdate): Promise<ApiToolSummary> {
    const current = await getRow(companyId, toolId);
    const updates: Partial<typeof companyApiTools.$inferInsert> = { updatedAt: new Date(now()) };
    if (patch.name !== undefined && patch.name !== current.name) {
      updates.name = patch.name;
      updates.key = await uniqueKey(companyId, deriveKey(patch.name), toolId);
    }
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.baseUrl !== undefined) {
      const normalized = normalizeApiToolBaseUrl(patch.baseUrl);
      if (!normalized.ok) throw unprocessable(normalized.message);
      updates.baseUrl = normalized.url;
    }
    if (patch.actions !== undefined) updates.actions = patch.actions;
    if (patch.openapiUrl !== undefined) updates.openapiUrl = patch.openapiUrl;
    if (patch.dailyCap !== undefined) updates.dailyCap = patch.dailyCap;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.auth !== undefined) updates.auth = patch.auth;
    if (patch.auth !== undefined) {
      // The binding is the only way to the key, so it is re-pointed before the
      // row says a different secret is in use.
      await bindKey(companyId, toolId, patch.auth, patch.name ?? current.name);
    }
    const [row] = await db
      .update(companyApiTools)
      .set(updates)
      .where(and(eq(companyApiTools.companyId, companyId), eq(companyApiTools.id, toolId)))
      .returning();
    if (!row) throw notFound("Tool not found");
    return toSummary(row);
  }

  async function remove(companyId: string, toolId: string): Promise<void> {
    await getRow(companyId, toolId);
    await db.delete(companyApiTools).where(and(eq(companyApiTools.companyId, companyId), eq(companyApiTools.id, toolId)));
    // Only the binding goes; the secret itself is never touched (it may be
    // shared with another tool, and it is the operator's to delete).
    await secrets
      .syncSecretRefsForTarget(companyId, { targetType: "api_tool", targetId: toolId }, [], { replaceAll: true })
      .catch(() => undefined);
  }

  async function list(companyId: string): Promise<ApiToolSummary[]> {
    const rows = await db.select().from(companyApiTools).where(eq(companyApiTools.companyId, companyId)).orderBy(companyApiTools.name);
    return rows.map(toSummary);
  }

  async function get(companyId: string, toolId: string): Promise<ApiToolSummary> {
    return toSummary(await getRow(companyId, toolId));
  }

  /** Every tool in the company, each flagged with whether the agent has it (the agent's Tools tab). */
  async function listForAgent(companyId: string, selectedToolIds: string[]): Promise<Array<ApiToolSummary & { enabled: boolean }>> {
    const selected = new Set(selectedToolIds);
    return (await list(companyId)).map((tool) => ({ ...tool, enabled: selected.has(tool.id) }));
  }

  /** The active tools among `toolIds`, for offering to an agent. Unknown or disabled ids are skipped. */
  async function listGranted(companyId: string, toolIds: string[]): Promise<ApiToolSummary[]> {
    if (toolIds.length === 0) return [];
    const rows = await db
      .select()
      .from(companyApiTools)
      .where(and(eq(companyApiTools.companyId, companyId), inArray(companyApiTools.id, toolIds), eq(companyApiTools.status, "active")))
      .orderBy(companyApiTools.name);
    return rows.map(toSummary);
  }

  async function agentToolIds(companyId: string, agentId: string): Promise<string[]> {
    const [row] = await db
      .select({ apiToolIds: agents.apiToolIds })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    return Array.isArray(row?.apiToolIds) ? (row!.apiToolIds as string[]) : [];
  }

  /**
   * The ONLY path from a tool back to its key. Goes through the real
   * company_secret_bindings row, so the read is authorised like every other
   * credential read and lands in secret_access_events. Never returned to a
   * route; only handed to the request builder in this file.
   */
  async function resolveKey(row: ApiToolRow, auth: ApiToolAuth, caller: ApiToolCaller): Promise<string> {
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, row.companyId),
          eq(companySecretBindings.targetType, "api_tool"),
          eq(companySecretBindings.targetId, row.id),
          eq(companySecretBindings.configPath, API_TOOL_CREDENTIAL_CONFIG_PATH),
        ),
      );
    if (!binding || binding.secretId !== auth.secretId) {
      throw unprocessable(`No key is attached to the tool "${row.name}". Open it on the Tools page and pick the secret again.`, { code: "binding_missing" });
    }
    return secrets.resolveSecretValue(row.companyId, binding.secretId, "latest", {
      consumerType: "api_tool",
      consumerId: row.id,
      configPath: API_TOOL_CREDENTIAL_CONFIG_PATH,
      actorType: caller.agentId ? "agent" : caller.userId ? "user" : "system",
      actorId: caller.agentId ?? caller.userId ?? null,
      heartbeatRunId: caller.runId,
    });
  }

  async function countCallsToday(toolId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(companyApiToolCalls)
      .where(
        and(
          eq(companyApiToolCalls.toolId, toolId),
          gte(companyApiToolCalls.createdAt, utcDayStart(now())),
          inArray(companyApiToolCalls.status, ["ok", "upstream_error", "network_error"]),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async function recordCall(row: ApiToolRow, actionName: string, caller: ApiToolCaller, outcome: {
    status: typeof companyApiToolCalls.$inferInsert.status;
    httpStatus: number | null;
    durationMs: number | null;
  }) {
    await db
      .insert(companyApiToolCalls)
      .values({
        companyId: row.companyId,
        toolId: row.id,
        action: actionName,
        channel: caller.channel,
        agentId: caller.agentId,
        userId: caller.userId,
        runId: caller.runId,
        status: outcome.status,
        httpStatus: outcome.httpStatus,
        durationMs: outcome.durationMs,
      })
      .catch(() => undefined);
  }

  /**
   * Makes one call. Refusals before the request goes out (validation, the
   * daily cap, a missing key) throw an HttpError with a plain sentence; a
   * request that went out always comes back as a result, with `error` set
   * when there was no answer. Every text in the result is scrubbed.
   */
  async function performCall(
    row: ApiToolRow,
    action: ApiToolAction,
    rawInput: Record<string, unknown>,
    caller: ApiToolCaller,
  ): Promise<ApiToolRunResult> {
    const auth = parseAuth(row);
    if (!auth) {
      throw unprocessable(`The tool "${row.name}" has no key attached. Open it on the Tools page and pick the secret.`, { code: "auth_missing" });
    }
    const input = validateActionInput(action, rawInput);
    const used = await countCallsToday(row.id);
    if (used >= row.dailyCap) {
      await recordCall(row, action.name, caller, { status: "rate_limited", httpStatus: null, durationMs: null });
      throw tooManyRequests(
        `The tool "${row.name}" has used its ${row.dailyCap} calls for today. It can run again after midnight UTC, or raise the daily limit on the Tools page.`,
        { code: "daily_cap", limit: row.dailyCap, used },
      );
    }
    const key = await resolveKey(row, auth, caller);
    const knownSecrets = [key];
    const scrub = (text: string) => scrubApiToolText(text, knownSecrets);
    const request = buildApiToolRequest(row.baseUrl, auth, action, input, key);
    const fetchImpl = createSafeOutboundFetch(createApiToolOutboundPolicy(row.baseUrl), { lookup: deps.lookup, testOnlyDial: deps.testOnlyDial });
    const started = now();
    let response: Response;
    try {
      response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body });
    } catch (error) {
      const durationMs = now() - started;
      const message =
        error instanceof SafeOutboundFetchError
          ? error.message
          : `Could not reach ${hostOf(row.baseUrl)}.`;
      await recordCall(row, action.name, caller, { status: "network_error", httpStatus: null, durationMs });
      return { ok: false, status: 0, contentType: null, body: "", truncated: false, urls: [], error: scrub(message), durationMs };
    }
    const durationMs = now() - started;
    const contentType = response.headers.get("content-type");
    const rawText = await response.text();
    const scrubbed = scrub(prettyBody(rawText, contentType));
    const truncated = scrubbed.length > API_TOOL_BODY_TEXT_LIMIT;
    const body = truncated
      ? `${scrubbed.slice(0, API_TOOL_BODY_TEXT_LIMIT)}\n\n[The answer was cut at 50 KB; ${scrubbed.length - API_TOOL_BODY_TEXT_LIMIT} more characters were not shown.]`
      : scrubbed;
    const ok = response.status >= 200 && response.status < 300;
    await recordCall(row, action.name, caller, { status: ok ? "ok" : "upstream_error", httpStatus: response.status, durationMs });
    return { ok, status: response.status, contentType, body, truncated, urls: findUrls(scrubbed), error: null, durationMs };
  }

  async function runAction(
    companyId: string,
    toolId: string,
    actionName: string,
    rawInput: Record<string, unknown>,
    caller: ApiToolCaller,
  ): Promise<ApiToolRunResult> {
    const row = await getRow(companyId, toolId);
    if (row.status !== "active") {
      throw unprocessable(`The tool "${row.name}" is switched off. Switch it on from the Tools page to use it.`, { code: "tool_disabled" });
    }
    const action = parseActions(row).find((entry) => entry.name === actionName);
    if (!action) {
      const names = parseActions(row).map((entry) => entry.name);
      throw notFound(
        names.length === 0
          ? `The tool "${row.name}" has no actions yet.`
          : `The tool "${row.name}" has no action called "${actionName}". It has: ${names.join(", ")}.`,
      );
    }
    return performCall(row, action, rawInput, caller);
  }

  /**
   * The Test button: one bounded call with the key attached -- the first GET
   * action that needs no input, else a GET of the base address itself -- and
   * a plain sentence about what came back. Saved on the row as last_test_*.
   */
  async function test(companyId: string, toolId: string, actor: { userId: string | null }): Promise<ApiToolTestResult> {
    const row = await getRow(companyId, toolId);
    const host = hostOf(row.baseUrl);
    const probe =
      parseActions(row).find((action) => action.method === "GET" && action.inputs.every((input) => !input.required)) ??
      ({ name: "_test", method: "GET", path: "/", description: "", inputs: [] } satisfies ApiToolAction);
    const caller: ApiToolCaller = { channel: "settings_test", agentId: null, userId: actor.userId, runId: null };
    let outcome: ApiToolTestResult;
    try {
      const result = await performCall(row, probe, {}, caller);
      const via = probe.name === "_test" ? "" : ` (${probe.method} ${probe.path})`;
      if (result.error) {
        outcome = { ok: false, status: 0, message: `Could not reach ${host}: ${result.error}` };
      } else if (result.ok) {
        outcome = { ok: true, status: result.status, message: `${host} answered ${result.status}${via}. The key was accepted.` };
      } else if (result.status === 401 || result.status === 403) {
        outcome = { ok: false, status: result.status, message: `${host} answered ${result.status}${via}: the key was not accepted. Check the secret and how the key is sent.` };
      } else if (result.status === 404 || result.status === 405) {
        outcome = {
          ok: false,
          status: result.status,
          message: `${host} answered ${result.status}${via}: the address is reachable, but that path is not one it knows. The key may still be fine; add an action that exists and test again.`,
        };
      } else if (result.status >= 500) {
        outcome = { ok: false, status: result.status, message: `${host} answered ${result.status}${via}: the service had a problem. Try again later.` };
      } else {
        outcome = { ok: false, status: result.status, message: `${host} answered ${result.status}${via}: the request was refused.` };
      }
    } catch (error) {
      const message = error instanceof HttpError ? error.message : `Could not test the tool "${row.name}".`;
      outcome = { ok: false, status: 0, message: scrubApiToolText(message, []) };
    }
    await db
      .update(companyApiTools)
      .set({ lastTestAt: new Date(now()), lastTestOk: outcome.ok, lastTestMessage: outcome.message, updatedAt: new Date(now()) })
      .where(eq(companyApiTools.id, row.id));
    return outcome;
  }

  return {
    create,
    update,
    remove,
    list,
    get,
    listForAgent,
    listGranted,
    agentToolIds,
    runAction,
    test,
    toSummary,
  };
}

export type ApiToolService = ReturnType<typeof apiToolService>;
