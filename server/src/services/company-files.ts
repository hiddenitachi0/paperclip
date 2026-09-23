import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  FILE_SERVER_PROTOCOLS,
  isFileServerKind,
  type DataConnectionAccessLevel,
  type DataReadChannel,
  type DataReadOutcome,
  type FileServerKind,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "./data-connections.js";
import { countDataReadEvents, recordDataReadEvent } from "./data-read-audit.js";
import { fileServerProblem } from "./data-sources/file-server-source.js";
import { FileServerError, isUpstreamFileServerError } from "./data-sources/file-server/errors.js";
import { displayRemotePath } from "./data-sources/file-server/paths.js";
import type { FileServerEntry } from "./data-sources/file-server/session.js";
import { scrubSecrets } from "./data-sources/shopify-client.js";
import { zonedDayStart, zonedParts } from "./data-sources/zoned-time.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * DUR-3997 (files on a server): the "custom" dataset's query service -- the
 * ONE place a quick agent's request for a company file becomes a read.
 * Modelled on business-data.ts, in the same fixed order:
 *
 *   1. the company comes from the caller's server-side context, never from input
 *   2. the company's ACTIVE file-server connections are listed; none means
 *      "not connected", said plainly
 *   3. the instance switch "Business data sources" must be on
 *   4. the input is validated strictly; the file type is checked before any
 *      server is contacted (only .csv, .txt, .md and .json are readable;
 *      spreadsheets are refused with a plain sentence -- no parser is a
 *      dependency, so none is used)
 *   5. the limits, all COUNTED FROM data_read_events: per run (signed run id
 *      only), per agent per minute, and the connection's own daily cap by
 *      Oslo day
 *   6. the credential is resolved inside openReadContext; never returned here
 *   7. the confined file operations run (list or read, never write)
 *   8. the text is capped at 200 KB, cut with a note, never silently
 *   9. the audit row is written -- for refusals too
 *
 * No write of any kind reaches this file. Writing through a `read_write`
 * connection is for a later slice, behind approvals.
 */

export const COMPANY_FILE_DATASET = "custom" as const;

export const COMPANY_FILE_LIMITS = {
  /** Same brake as sales lookups: at most this many file reads per run. */
  perRun: 15,
  perAgentPerMinute: 6,
} as const;

/** The most text one read hands back to the model. */
export const COMPANY_FILE_TEXT_MAX_BYTES = 200 * 1024;
/**
 * The most a file read for an agent pulls from the server at all: a little
 * over the text cap, so a file between the two is cut with a note and a
 * larger one is refused by size (SIZE/stat, or the stream cap) with a plain
 * sentence -- never 25 MB fetched to show 200 KB.
 */
export const COMPANY_FILE_READ_MAX_BYTES = 256 * 1024;
/** Folder entries shown per listing at most. */
export const COMPANY_FILE_LIST_MAX_ENTRIES = 200;
/** The whole lookup (connect, list or read, close) must finish in this time; the transport enforces it. */
export const COMPANY_FILE_LOOKUP_TIMEOUT_MS = 70_000;
/** Server operations one lookup may spend (a read is one; a listing is one). */
const LOOKUP_BUDGET = { maxRequests: 2, deadlineMs: COMPANY_FILE_LOOKUP_TIMEOUT_MS };
const LIMIT_DAY_TIMEZONE = "Europe/Oslo";
/** Rows that do not count towards any limit: a refusal for being over a limit. */
const NOT_COUNTED_OUTCOMES: DataReadOutcome[] = ["rate_limited"];

export const READABLE_TEXT_EXTENSIONS = ["csv", "txt", "md", "json"] as const;
const READABLE_TEXT_EXTENSION_SET: ReadonlySet<string> = new Set(READABLE_TEXT_EXTENSIONS);
const SPREADSHEET_EXTENSION_SET: ReadonlySet<string> = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods", "numbers"]);

export const SPREADSHEET_NOT_READABLE_MESSAGE =
  "Spreadsheet files are not readable yet. Ask for the same data as a CSV export, which can be read.";

/** The input a quick agent's tool call may carry. Strict: an unknown field is refused, never ignored. */
export const readCompanyFileInputSchema = z
  .object({
    action: z.enum(["read", "list"]).default("read"),
    /** Relative to the server's base folder; "" or "/" is the base folder itself. */
    path: z.string().max(1024).default(""),
    /** The connection's name (or id); needed only when the company has more than one. */
    server: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ReadCompanyFileInput = z.infer<typeof readCompanyFileInputSchema>;

/** Who is asking. Built by the server from the authenticated request, never from tool input. */
export interface CompanyFileCaller {
  companyId: string;
  channel: DataReadChannel;
  agentId: string | null;
  userId: string | null;
  /** The run from a SIGNED agent token only (see signedRunIdFromActor). */
  runId: string | null;
  laneAConversationId: string | null;
}

/** One active file-server connection, as the prompt and the tool describe it. No secret, no host key. */
export interface CompanyFileServerSummary {
  id: string;
  name: string;
  kind: FileServerKind;
  kindLabel: string;
  protocol: "ftp" | "ftps" | "sftp";
  access: DataConnectionAccessLevel;
  basePath: string;
  /** "host[:port]/base", for people. */
  target: string;
  dailyLookupCap: number;
}

export interface CompanyFileAnswer {
  ok: boolean;
  outcome: DataReadOutcome;
  refusalCode: string | null;
  /** The audit row id; null only when a refusal could not be audited. */
  lookupId: string | null;
  /** What the model is shown. */
  text: string;
}

export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The file as text for the model: UTF-8, BOM dropped, cut at the cap on a
 * line boundary where one is near, with a note that says how much is missing.
 */
export function renderFileText(bytes: Buffer, maxBytes = COMPANY_FILE_TEXT_MAX_BYTES): { text: string; truncated: boolean } {
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  if (body.length <= maxBytes) return { text: body.toString("utf8"), truncated: false };
  let cut = maxBytes;
  const newline = body.subarray(Math.max(0, maxBytes - 2048), maxBytes).lastIndexOf(0x0a);
  if (newline !== -1) cut = Math.max(0, maxBytes - 2048) + newline + 1;
  const shown = body.subarray(0, cut).toString("utf8").replace(/�+$/, "");
  return {
    text: `${shown}\n\n[Truncated: showing the first ${formatBytes(cut)} of ${formatBytes(body.length)}. Ask for a smaller file or a specific part.]`,
    truncated: true,
  };
}

function formatEntry(entry: FileServerEntry): string {
  const when = entry.modifiedAt ? entry.modifiedAt.toISOString().slice(0, 16).replace("T", " ") : "";
  if (entry.type === "directory") return `${entry.name}/\tfolder${when ? `\t${when}` : ""}`;
  const size = entry.size === null ? "" : formatBytes(entry.size);
  return `${entry.name}\t${size}${when ? `\t${when}` : ""}`.trimEnd();
}

export function renderListing(entries: FileServerEntry[], max = COMPANY_FILE_LIST_MAX_ENTRIES): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : b.type === "directory" ? 1 : 0;
    return a.name.localeCompare(b.name);
  });
  if (sorted.length === 0) return "(empty folder)";
  const lines = sorted.slice(0, max).map(formatEntry);
  if (sorted.length > max) lines.push(`… and ${sorted.length - max} more entries not shown.`);
  return lines.join("\n");
}

function describeServer(server: CompanyFileServerSummary): string {
  return `"${server.name}" (${server.kindLabel}, ${server.access === "read_write" ? "read and write" : "read-only"}, base folder ${server.basePath})`;
}

/** The normalised input for the audit row: known fields only. */
function auditParams(raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const clip = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : value);
  if (typeof input.action === "string") out.action = clip(input.action);
  if (typeof input.path === "string") out.path = clip(input.path);
  if (typeof input.server === "string") out.server = clip(input.server);
  const unknown = Object.keys(input).filter((key) => !["action", "path", "server"].includes(key));
  if (unknown.length > 0) out.rejectedFields = unknown.slice(0, 10).map((key) => key.slice(0, 60));
  return out;
}

export interface CompanyFileServiceDeps extends DataConnectionServiceDeps {}

export function companyFileService(db: Db, deps: CompanyFileServiceDeps = {}) {
  const connections = dataConnectionService(db, deps);
  const instanceSettings = instanceSettingsService(db);
  const nowMs = deps.now ?? Date.now;

  async function featureOn(): Promise<boolean> {
    const experimental = await instanceSettings.getExperimental();
    return experimental.enableBusinessData === true;
  }

  async function companyName(companyId: string): Promise<string> {
    const [row] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    return row?.name ?? "This company";
  }

  /** The company's active file-server connections, for the prompt and the tool. Empty while the instance switch is off. */
  async function listAvailable(companyId: string): Promise<CompanyFileServerSummary[]> {
    if (!(await featureOn())) return [];
    const all = await connections.list(companyId);
    const servers: CompanyFileServerSummary[] = [];
    for (const connection of all) {
      if (connection.status !== "active" || !isFileServerKind(connection.kind) || connection.config.kind !== connection.kind) continue;
      servers.push({
        id: connection.id,
        name: connection.name,
        kind: connection.kind,
        kindLabel: connection.kindLabel,
        protocol: FILE_SERVER_PROTOCOLS[connection.kind],
        access: connection.access,
        basePath: connection.config.remotePath,
        target: connection.target,
        dailyLookupCap: connection.dailyLookupCap,
      });
    }
    return servers;
  }

  async function isAvailable(companyId: string): Promise<boolean> {
    return (await listAvailable(companyId)).length > 0;
  }

  async function writeAudit(
    caller: CompanyFileCaller,
    input: {
      id?: string;
      connectionId: string | null;
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      refusalCode: string | null;
      facts?: Record<string, unknown> | null;
      upstreamRequests?: number;
      startedAt: number;
      scrubValues?: string[];
    },
  ): Promise<string> {
    return recordDataReadEvent(db, {
      id: input.id,
      createdAt: new Date(nowMs()),
      companyId: caller.companyId,
      connectionId: input.connectionId,
      dataset: COMPANY_FILE_DATASET,
      channel: caller.channel,
      agentId: caller.agentId,
      userId: caller.userId,
      runId: caller.runId,
      laneAConversationId: caller.laneAConversationId,
      params: input.params,
      outcome: input.outcome,
      refusalCode: input.refusalCode,
      facts: input.facts ?? null,
      upstreamRequests: input.upstreamRequests ?? 0,
      costPoints: 0,
      durationMs: nowMs() - input.startedAt,
      scrubValues: input.scrubValues,
    });
  }

  /** A refusal with its audit row. The sentence is given even if the audit row fails. */
  async function refuse(
    caller: CompanyFileCaller,
    input: {
      connectionId: string | null;
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      code: string;
      message: string;
      upstreamRequests?: number;
      startedAt: number;
      scrubValues?: string[];
    },
  ): Promise<CompanyFileAnswer> {
    let lookupId: string | null = null;
    try {
      lookupId = await writeAudit(caller, {
        connectionId: input.connectionId,
        params: input.params,
        outcome: input.outcome,
        refusalCode: input.code,
        facts: { answer: input.message },
        upstreamRequests: input.upstreamRequests,
        startedAt: input.startedAt,
        scrubValues: input.scrubValues,
      });
    } catch (error) {
      logger.warn(
        { companyId: caller.companyId, code: input.code, err: error instanceof Error ? error.message : String(error) },
        "company files: could not write the audit row for a refusal",
      );
    }
    return { ok: false, outcome: input.outcome, refusalCode: input.code, lookupId, text: input.message };
  }

  async function limitRefusal(
    caller: CompanyFileCaller,
    server: CompanyFileServerSummary,
    name: string,
  ): Promise<{ code: string; message: string } | null> {
    const now = new Date(nowMs());
    const base = { companyId: caller.companyId, dataset: COMPANY_FILE_DATASET, excludeOutcomes: NOT_COUNTED_OUTCOMES };
    if (caller.runId) {
      const used = await countDataReadEvents(db, { ...base, runId: caller.runId, since: new Date(0) });
      if (used >= COMPANY_FILE_LIMITS.perRun) {
        return {
          code: "run_limit",
          message: `This run has already read ${COMPANY_FILE_LIMITS.perRun} company files, which is the limit per run. No more files are read now.`,
        };
      }
    }
    if (caller.agentId) {
      const used = await countDataReadEvents(db, { ...base, agentId: caller.agentId, since: new Date(now.getTime() - 60_000) });
      if (used >= COMPANY_FILE_LIMITS.perAgentPerMinute) {
        return {
          code: "agent_minute_limit",
          message: `I have read ${COMPANY_FILE_LIMITS.perAgentPerMinute} company files in the last minute, which is the limit per agent. Wait a minute and ask again.`,
        };
      }
    }
    const today = zonedParts(now, LIMIT_DAY_TIMEZONE);
    const dayStart = zonedDayStart(today.year, today.month, today.day, LIMIT_DAY_TIMEZONE);
    const usedToday = await countDataReadEvents(db, { ...base, connectionId: server.id, since: dayStart });
    if (usedToday >= server.dailyLookupCap) {
      return {
        code: "daily_cap",
        message:
          `${name} has used all ${server.dailyLookupCap} file operations on "${server.name}" for today, which is that server's daily limit. ` +
          "The limit resets at midnight (Norwegian time). A board user can raise it under Settings → Data sources.",
      };
    }
    return null;
  }

  /**
   * One read or listing. Never throws for anything a person could cause:
   * every path ends in an answer, and every answer (refusals included) has
   * an audit row.
   */
  async function read(caller: CompanyFileCaller, rawInput: unknown): Promise<CompanyFileAnswer> {
    const startedAt = nowMs();
    const params = auditParams(rawInput);
    let connectionId: string | null = null;
    let scrubValues: () => string[] = () => [];
    let requests = 0;
    let close: (() => Promise<void>) | null = null;
    try {
      const name = await companyName(caller.companyId);
      if (!(await featureOn())) {
        return refuse(caller, {
          connectionId: null, params, outcome: "refused", code: "business_data_disabled",
          message: "Data sources are switched off for this Paperclip installation, so no company files can be read now. An administrator can switch them on.",
          startedAt,
        });
      }
      const parsed = readCompanyFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return refuse(caller, {
          connectionId: null, params, outcome: "refused", code: "invalid_input",
          message: `The request was not understood${first ? ` (${first.path.join(".") || "input"}: ${first.message})` : ""}. Send only action, path and, when needed, server.`,
          startedAt,
        });
      }
      const input = parsed.data;

      const servers = await listAvailable(caller.companyId);
      if (servers.length === 0) {
        return refuse(caller, {
          connectionId: null, params, outcome: "refused", code: "not_connected",
          message: `${name} has no file server connected. A board user can add one under Settings → Data sources.`,
          startedAt,
        });
      }
      let server: CompanyFileServerSummary | undefined;
      if (input.server) {
        const wanted = input.server.toLowerCase();
        server = servers.find((entry) => entry.id === input.server || entry.name.trim().toLowerCase() === wanted);
        if (!server) {
          return refuse(caller, {
            connectionId: null, params, outcome: "refused", code: "unknown_server",
            message: `No connected file server is called "${input.server}". Available: ${servers.map(describeServer).join("; ")}.`,
            startedAt,
          });
        }
      } else if (servers.length === 1) {
        server = servers[0]!;
      } else {
        return refuse(caller, {
          connectionId: null, params, outcome: "refused", code: "ambiguous_server",
          message: `${name} has several file servers: ${servers.map(describeServer).join("; ")}. Say which one with the server field.`,
          startedAt,
        });
      }
      connectionId = server.id;

      // The file type is decided before any server is contacted.
      if (input.action === "read") {
        const extension = fileExtension(input.path);
        if (SPREADSHEET_EXTENSION_SET.has(extension)) {
          return refuse(caller, {
            connectionId, params, outcome: "refused", code: "spreadsheet_not_supported",
            message: `${SPREADSHEET_NOT_READABLE_MESSAGE} (${input.path.split("/").pop()})`,
            startedAt,
          });
        }
        if (!READABLE_TEXT_EXTENSION_SET.has(extension)) {
          return refuse(caller, {
            connectionId, params, outcome: "refused", code: "file_type_not_supported",
            message: `Only ${READABLE_TEXT_EXTENSIONS.map((entry) => `.${entry}`).join(", ")} files can be read${extension ? ` (this is .${extension})` : ""}. Use action "list" to see what the folder holds.`,
            startedAt,
          });
        }
      }

      const limit = await limitRefusal(caller, server, name);
      if (limit) {
        return refuse(caller, { connectionId, params, outcome: "rate_limited", code: limit.code, message: limit.message, startedAt });
      }

      const opened = await connections.openReadContext(
        caller.companyId,
        server.id,
        { actorType: caller.agentId ? "agent" : "user", actorId: caller.agentId ?? caller.userId ?? "system" },
        LOOKUP_BUDGET,
      );
      scrubValues = opened.knownSecrets;
      if (opened.read.kind !== server.kind) {
        return refuse(caller, {
          connectionId, params, outcome: "refused", code: "data_source_kind_mismatch",
          message: "The connection is not a file server.", startedAt,
        });
      }
      const files = opened.read.files;
      close = () => files.close();

      const lookupId = randomUUID();
      let text: string;
      let facts: Record<string, unknown>;
      try {
        if (input.action === "list") {
          const listing = await files.list(input.path);
          const display = displayRemotePath(files.basePath, listing.path);
          text = [
            `Folder ${display} on "${server.name}" (${listing.entries.length} ${listing.entries.length === 1 ? "entry" : "entries"}). Lookup ${lookupId}.`,
            "",
            renderListing(listing.entries),
          ].join("\n");
          facts = { path: display, entries: listing.entries.length };
        } else {
          const result = await files.read(input.path, { maxBytes: COMPANY_FILE_READ_MAX_BYTES });
          const display = displayRemotePath(files.basePath, result.path);
          const rendered = renderFileText(result.bytes);
          const modified = result.modifiedAt ? `, modified ${result.modifiedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
          text = [
            `File ${display} on "${server.name}" (${formatBytes(result.size)}${modified}). Lookup ${lookupId}.`,
            "",
            rendered.text,
          ].join("\n");
          facts = { path: display, bytes: result.size, truncated: rendered.truncated };
        }
      } finally {
        requests = files.stats().requests;
      }
      await writeAudit(caller, {
        id: lookupId,
        connectionId,
        params,
        outcome: "ok",
        refusalCode: null,
        facts,
        upstreamRequests: requests,
        startedAt,
        scrubValues: scrubValues(),
      });
      return { ok: true, outcome: "ok", refusalCode: null, lookupId, text: scrubSecrets(text, scrubValues()) };
    } catch (error) {
      if (error instanceof FileServerError) {
        return refuse(caller, {
          connectionId,
          params,
          outcome: isUpstreamFileServerError(error.code) ? "upstream_error" : "refused",
          code: error.code,
          message: scrubSecrets(fileServerProblem(error), scrubValues()),
          upstreamRequests: requests,
          startedAt,
          scrubValues: scrubValues(),
        });
      }
      if (error instanceof HttpError && error.status === 422) {
        return refuse(caller, {
          connectionId, params, outcome: "refused",
          code: ((error.details as { code?: string } | undefined)?.code) ?? "refused",
          message: scrubSecrets(error.message, scrubValues()),
          upstreamRequests: requests, startedAt, scrubValues: scrubValues(),
        });
      }
      logger.error(
        { companyId: caller.companyId, connectionId, err: error instanceof Error ? error.name : "unknown" },
        "company files: unexpected failure",
      );
      return refuse(caller, {
        connectionId, params, outcome: "upstream_error", code: "unexpected",
        message: "The file could not be read because of an error, so nothing is shown. The error is logged.",
        upstreamRequests: requests, startedAt, scrubValues: scrubValues(),
      });
    } finally {
      if (close) await close().catch(() => undefined);
    }
  }

  return { featureOn, companyName, listAvailable, isAvailable, read };
}

export type CompanyFileService = ReturnType<typeof companyFileService>;
