import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { ACTION_ADD, ACTION_LIST, ACTION_PORTFOLIO, ACTION_REMOVE } from "./manifest.js";

// A registered remote instance. The board API key is kept in plugin state and
// NEVER returned to the browser — only aggregated, non-secret portfolio data is.
interface Remote {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
}

const STATE = { scopeKind: "instance" as const, stateKey: "remotes" };

async function loadRemotes(ctx: PluginContext): Promise<Remote[]> {
  const raw = (await ctx.state.get(STATE)) as Remote[] | null;
  return Array.isArray(raw) ? raw : [];
}

async function saveRemotes(ctx: PluginContext, remotes: Remote[]): Promise<void> {
  await ctx.state.set(STATE, remotes);
}

function publicRemote(r: Remote) {
  return { id: r.id, label: r.label, baseUrl: r.baseUrl };
}

function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "remote";
}

async function fetchJson(ctx: PluginContext, url: string, token: string): Promise<unknown | null> {
  const res = await ctx.http.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

// Aggregate one remote's per-company portfolio. Never throws — returns a
// reachable:false entry on any failure so one bad remote doesn't sink the view.
async function fetchRemotePortfolio(ctx: PluginContext, remote: Remote) {
  const base = remote.baseUrl.replace(/\/$/, "");
  try {
    const health = (await fetchJson(ctx, `${base}/api/health`, remote.token)) as
      | { version?: string; status?: string }
      | null;
    const companies = (await fetchJson(ctx, `${base}/api/companies`, remote.token)) as
      | Array<{ id: string; name: string; issuePrefix: string; spentMonthlyCents?: number; budgetMonthlyCents?: number }>
      | null;
    if (!companies) {
      return { ...publicRemote(remote), reachable: false, error: "Could not reach /api/companies (check URL + board API key)" };
    }
    const stats = ((await fetchJson(ctx, `${base}/api/companies/stats`, remote.token)) ?? {}) as Record<
      string,
      { agentCount?: number; issueCount?: number }
    >;

    const companyData = [];
    for (const c of companies) {
      const [runs, approvals] = await Promise.all([
        fetchJson(ctx, `${base}/api/companies/${c.id}/live-runs?minCount=0&limit=100`, remote.token),
        fetchJson(ctx, `${base}/api/companies/${c.id}/approvals`, remote.token),
      ]);
      const runList = (Array.isArray(runs) ? runs : []) as Array<{ status?: string; livenessState?: string }>;
      const approvalList = (Array.isArray(approvals) ? approvals : []) as Array<{ status?: string }>;
      const running = runList.filter((r) => r.status === "running").length;
      const queued = runList.filter((r) => r.status === "queued" || r.status === "scheduled_retry").length;
      const needsYou =
        runList.filter((r) => r.livenessState === "needs_followup").length +
        approvalList.filter((a) => a.status === "pending" || a.status === "revision_requested").length;
      companyData.push({
        id: c.id,
        name: c.name,
        issuePrefix: c.issuePrefix,
        running,
        queued,
        needsYou,
        agentCount: stats[c.id]?.agentCount ?? 0,
        issueCount: stats[c.id]?.issueCount ?? 0,
        spentCents: c.spentMonthlyCents ?? 0,
        budgetCents: c.budgetMonthlyCents ?? 0,
        deepLink: `${base}/${c.issuePrefix}/dashboard/now`,
      });
    }
    return {
      ...publicRemote(remote),
      reachable: true,
      version: health?.version ?? null,
      companies: companyData,
    };
  } catch (err) {
    return { ...publicRemote(remote), reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.actions.register(ACTION_LIST, async () => {
      return { remotes: (await loadRemotes(ctx)).map(publicRemote) };
    });

    ctx.actions.register(ACTION_ADD, async (params) => {
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const baseUrl = typeof params.baseUrl === "string" ? params.baseUrl.trim().replace(/\/$/, "") : "";
      const token = typeof params.token === "string" ? params.token.trim() : "";
      if (!label || !baseUrl || !token) throw new Error("label, baseUrl, and a board API key are all required");
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http:// or https://");
      const remotes = await loadRemotes(ctx);
      const id = `${slugify(label)}-${Date.now()}`;
      remotes.push({ id, label, baseUrl, token });
      await saveRemotes(ctx, remotes);
      return { remotes: remotes.map(publicRemote) };
    });

    ctx.actions.register(ACTION_REMOVE, async (params) => {
      const id = typeof params.id === "string" ? params.id : "";
      const remotes = (await loadRemotes(ctx)).filter((r) => r.id !== id);
      await saveRemotes(ctx, remotes);
      return { remotes: remotes.map(publicRemote) };
    });

    ctx.actions.register(ACTION_PORTFOLIO, async () => {
      const remotes = await loadRemotes(ctx);
      const portfolio = [];
      for (const remote of remotes) portfolio.push(await fetchRemotePortfolio(ctx, remote));
      return { portfolio };
    });

    ctx.logger.info("mission-control plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Mission Control ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
