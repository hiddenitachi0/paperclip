import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentDailyCounters, companySecretBindings, companySecrets, withCompanyScope } from "@paperclipai/db";
import {
  WEB_SEARCH_BINDING_TARGET_TYPE,
  WEB_SEARCH_COUNTER_KIND,
  WEB_SEARCH_DEFAULT_DAILY_CAP,
  WEB_SEARCH_KEY_CONFIG_PATH,
  type CompanyWebSearchSettings,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import {
  BRAVE_SEARCH_OUTBOUND_POLICY,
  PUBLIC_WEB_PAGE_OUTBOUND_POLICY,
  SafeOutboundFetchError,
  createSafeOutboundFetch,
  type SafeOutboundFetchDeps,
} from "./safe-outbound-fetch.js";
import {
  WebToolError,
  classifyWebPageContentType,
  decodePageBytes,
  runBraveSearch,
  type WebSearchRequest,
  type WebSearchResult,
} from "./lane-a-web-tools.js";

/**
 * Web search for quick agents: the company's Brave key, the daily cap, and
 * the two outbound calls (Brave, one web page).
 *
 * The key: the operator picks one of the company's secrets under Company
 * settings → Connections → Web search. The pick is a company_secret_bindings
 * row (target 'web_search', target id = the company id, config path
 * WEB_SEARCH_KEY_CONFIG_PATH), so reading the key goes through the ordinary
 * binding check and lands in secret_access_events, and the key never leaves
 * this file except inside the X-Subscription-Token header.
 *
 * The cap: WEB_SEARCH_DEFAULT_DAILY_CAP searches per company per UTC day, all
 * its quick agents together. Each search is counted per agent in
 * agent_daily_counters (kind 'web_search') BEFORE it goes out; the company
 * total is the sum of those rows. Two searches racing at the cap are settled
 * by a per-company advisory lock around the count-and-increment, so the cap
 * is never exceeded and the last slot is never lost.
 */

export interface WebSearchCaller {
  agentId: string;
  userId: string | null;
  /** Who the secret read is logged as. */
  actorType: "agent" | "user" | "system";
  actorId: string | null;
}

export interface WebSearchServiceDeps extends SafeOutboundFetchDeps {
  now?: () => Date;
  /** Tests swap the Brave and page fetches for fakes. */
  braveFetch?: typeof fetch;
  pageFetch?: typeof fetch;
}

export interface FetchedWebPage {
  url: string;
  contentType: string | null;
  kind: "html" | "text";
  body: string;
}

function utcDayString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function webSearchDailyCapMessage(cap: number): string {
  return (
    `Not searched: this company's quick agents have used all ${cap} web searches for today. ` +
    `Searching works again after midnight UTC. Tell the person plainly, and do not guess an answer.`
  );
}

export function webSearchService(db: Db, deps: WebSearchServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const secrets = secretService(db);

  async function findBinding(companyId: string) {
    const [binding] = await db
      .select({ secretId: companySecretBindings.secretId })
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, WEB_SEARCH_BINDING_TARGET_TYPE),
          eq(companySecretBindings.targetId, companyId),
          eq(companySecretBindings.configPath, WEB_SEARCH_KEY_CONFIG_PATH),
        ),
      );
    return binding ?? null;
  }

  async function usedToday(companyId: string): Promise<number> {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${agentDailyCounters.count}), 0)::int` })
      .from(agentDailyCounters)
      .where(
        and(
          eq(agentDailyCounters.companyId, companyId),
          eq(agentDailyCounters.kind, WEB_SEARCH_COUNTER_KIND),
          eq(agentDailyCounters.day, utcDayString(now())),
        ),
      );
    return Number(row?.total ?? 0);
  }

  async function getSettings(companyId: string): Promise<CompanyWebSearchSettings> {
    const binding = await findBinding(companyId);
    let secret: { name: string; kind: string | null; status: string } | null = null;
    if (binding) {
      const [row] = await db
        .select({ name: companySecrets.name, kind: companySecrets.kind, status: companySecrets.status })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, binding.secretId), eq(companySecrets.companyId, companyId)));
      secret = row ?? null;
    }
    return {
      keySecretId: binding?.secretId ?? null,
      keySecretName: secret?.name ?? null,
      keySecretKind: secret?.kind ?? null,
      keyStatus: !binding ? "none" : secret?.status === "active" ? "ok" : "unusable",
      dailyCap: WEB_SEARCH_DEFAULT_DAILY_CAP,
      usedToday: await usedToday(companyId),
    };
  }

  /** True when a key is picked and its secret is active. Searches are offered only then. */
  async function hasUsableKey(companyId: string): Promise<boolean> {
    return (await getSettings(companyId)).keyStatus === "ok";
  }

  /** Pick (or, with null, remove) the company's Brave key. Owner/admin only; the route checks. */
  async function setKey(companyId: string, secretId: string | null, actor: { userId: string | null }) {
    if (secretId) {
      const [secret] = await db
        .select({ id: companySecrets.id, status: companySecrets.status })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)));
      if (!secret || secret.status === "deleted") throw notFound("That secret does not exist in this company.");
      if (secret.status !== "active") throw unprocessable("That secret is switched off. Pick an active one.");
    }
    // assertSecretInCompany and the dedicated-credential rule run inside.
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: WEB_SEARCH_BINDING_TARGET_TYPE, targetId: companyId },
      secretId ? [{ secretId, configPath: WEB_SEARCH_KEY_CONFIG_PATH, label: "Web search (Brave) for quick agents" }] : [],
      { replaceAll: true },
    );
    await logActivity(db, {
      companyId,
      actorType: actor.userId ? "user" : "system",
      actorId: actor.userId ?? "board",
      action: secretId ? "company.web_search_key_set" : "company.web_search_key_removed",
      entityType: "company",
      entityId: companyId,
      details: secretId ? { secretId } : {},
    });
    return getSettings(companyId);
  }

  async function resolveKey(companyId: string, caller: WebSearchCaller): Promise<string | null> {
    const binding = await findBinding(companyId);
    if (!binding) return null;
    try {
      const value = await secrets.resolveSecretValue(companyId, binding.secretId, "latest", {
        consumerType: WEB_SEARCH_BINDING_TARGET_TYPE,
        consumerId: companyId,
        configPath: WEB_SEARCH_KEY_CONFIG_PATH,
        actorType: caller.actorType,
        actorId: caller.actorId,
      });
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Count one search for this agent, unless the company is at its cap.
   * Returns the company total before this search. Two searches of the same
   * company are serialised by a transaction-scoped advisory lock, so the
   * last slot of the day goes to exactly one of them.
   */
  async function reserveSearch(companyId: string, agentId: string): Promise<{ allowed: boolean; used: number; cap: number }> {
    const cap = WEB_SEARCH_DEFAULT_DAILY_CAP;
    const day = utcDayString(now());
    return withCompanyScope(db, companyId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`web_search_cap:${companyId}`}))`);
      const [row] = await tx
        .select({ total: sql<number>`coalesce(sum(${agentDailyCounters.count}), 0)::int` })
        .from(agentDailyCounters)
        .where(
          and(
            eq(agentDailyCounters.companyId, companyId),
            eq(agentDailyCounters.kind, WEB_SEARCH_COUNTER_KIND),
            eq(agentDailyCounters.day, day),
          ),
        );
      const used = Number(row?.total ?? 0);
      if (used >= cap) return { allowed: false, used, cap };
      await tx
        .insert(agentDailyCounters)
        .values({ companyId, agentId, kind: WEB_SEARCH_COUNTER_KIND, day, count: 1 })
        .onConflictDoUpdate({
          target: [agentDailyCounters.agentId, agentDailyCounters.kind, agentDailyCounters.day],
          set: { count: sql`${agentDailyCounters.count} + 1`, updatedAt: new Date() },
        });
      return { allowed: true, used, cap };
    });
  }

  /**
   * One search for a quick agent: key, cap, call. Throws WebToolError with a
   * sentence the model can pass on; never the key.
   */
  async function search(
    companyId: string,
    request: WebSearchRequest,
    caller: WebSearchCaller,
  ): Promise<{ results: WebSearchResult[]; used: number; cap: number }> {
    const key = await resolveKey(companyId, caller);
    if (!key) {
      throw new WebToolError(
        "Web search is not set up for this company (no usable Brave Search key). Tell the person an owner or admin " +
          "can pick one under Company settings → Connections → Web search. Do not guess an answer.",
      );
    }
    const reservation = await reserveSearch(companyId, caller.agentId);
    if (!reservation.allowed) throw new WebToolError(webSearchDailyCapMessage(reservation.cap));
    const fetchImpl =
      deps.braveFetch ?? createSafeOutboundFetch(BRAVE_SEARCH_OUTBOUND_POLICY, { lookup: deps.lookup, testOnlyDial: deps.testOnlyDial });
    const results = await runBraveSearch(request, key, fetchImpl);
    return { results, used: reservation.used + 1, cap: reservation.cap };
  }

  /** One public https page through the guarded fetch. Throws WebToolError with a plain sentence. */
  async function fetchPage(url: string): Promise<FetchedWebPage> {
    const fetchImpl =
      deps.pageFetch ?? createSafeOutboundFetch(PUBLIC_WEB_PAGE_OUTBOUND_POLICY, { lookup: deps.lookup, testOnlyDial: deps.testOnlyDial });
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "accept-language": "en,nb;q=0.8,*;q=0.5",
          "user-agent": "Mozilla/5.0 (compatible; PaperclipQuickAgent/1.0; reads one page a person asked about)",
        },
      });
    } catch (error) {
      const reason = error instanceof SafeOutboundFetchError ? error.message : "the site could not be reached";
      throw new WebToolError(`Could not open the page: ${reason} Say so plainly; do not guess what it says.`);
    }
    if (!response.ok) {
      throw new WebToolError(
        `The page answered HTTP ${response.status}${response.status === 403 || response.status === 401 ? " (the site does not let Paperclip read it)" : ""}. ` +
          "Say so plainly; do not guess what it says.",
      );
    }
    const contentType = response.headers.get("content-type");
    const kind = classifyWebPageContentType(contentType);
    if (kind === "unsupported") {
      throw new WebToolError(
        `That address is not a web page Paperclip can read (${(contentType ?? "unknown type").split(";")[0]}). ` +
          "PDFs, pictures and downloads cannot be read yet. Say so plainly.",
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { url, contentType, kind, body: decodePageBytes(bytes, contentType) };
  }

  return { getSettings, hasUsableKey, setKey, resolveKey, reserveSearch, usedToday, search, fetchPage };
}
