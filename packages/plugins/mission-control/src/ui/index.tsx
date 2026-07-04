import { useCallback, useEffect, useState } from "react";
import type { PluginPageProps, PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, useHostNavigation } from "@paperclipai/plugin-sdk/ui";

// Standalone ES module — keep in sync with manifest.ts (no sibling imports).
const ROUTE_PATH = "mission-control";
const ACTION_LIST = "list-remotes";
const ACTION_ADD = "add-remote";
const ACTION_REMOVE = "remove-remote";
const ACTION_PORTFOLIO = "get-portfolio";

type RemoteRef = { id: string; label: string; baseUrl: string };
type CompanyStat = {
  id: string;
  name: string;
  issuePrefix: string;
  running: number;
  queued: number;
  needsYou: number;
  agentCount: number;
  issueCount: number;
  spentCents: number;
  budgetCents: number;
  deepLink: string;
};
type RemotePortfolio = RemoteRef & {
  reachable: boolean;
  version?: string | null;
  error?: string;
  companies?: CompanyStat[];
};

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function GlobeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function SidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return (
    <a
      {...nav.linkProps(`/${ROUTE_PATH}`)}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden className="shrink-0"><GlobeIcon /></span>
      <span className="flex-1 truncate">Mission Control</span>
    </a>
  );
}

export function MissionControlPage(_props: PluginPageProps) {
  const listAction = usePluginAction(ACTION_LIST);
  const addAction = usePluginAction(ACTION_ADD);
  const removeAction = usePluginAction(ACTION_REMOVE);
  const portfolioAction = usePluginAction(ACTION_PORTFOLIO);

  const [remotes, setRemotes] = useState<RemoteRef[]>([]);
  const [portfolio, setPortfolio] = useState<RemotePortfolio[]>([]);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy("refresh");
    setError(null);
    try {
      const [{ remotes: rs }, { portfolio: pf }] = (await Promise.all([
        listAction({}),
        portfolioAction({}),
      ])) as [{ remotes: RemoteRef[] }, { portfolio: RemotePortfolio[] }];
      setRemotes(rs ?? []);
      setPortfolio(pf ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [listAction, portfolioAction]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = async () => {
    setBusy("add");
    setError(null);
    try {
      await addAction({ label, baseUrl, token });
      setLabel("");
      setBaseUrl("");
      setToken("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async (id: string) => {
    setBusy(`remove-${id}`);
    try {
      await removeAction({ id });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto", fontSize: 13 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2"><GlobeIcon size={22} /> Mission Control</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your Paperclip instances at a glance — live work, what needs you, cost, and health.
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={busy === "refresh"} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/50">
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error ? <div style={{ background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, marginBottom: 12 }}>{error}</div> : null}

      {/* Add remote */}
      <div className="rounded-xl border border-border p-4" style={{ marginBottom: 20 }}>
        <div className="text-sm font-semibold text-foreground" style={{ marginBottom: 8 }}>Register a remote instance</div>
        <div className="flex flex-wrap gap-2 items-end">
          <Labeled label="Label">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Client Alpha" style={inputStyle} />
          </Labeled>
          <Labeled label="Base URL">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://alpha.tailnet:3100" style={{ ...inputStyle, width: 260 }} />
          </Labeled>
          <Labeled label="Board API key">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="board key" style={inputStyle} autoComplete="off" />
          </Labeled>
          <button type="button" onClick={onAdd} disabled={busy === "add" || !label || !baseUrl || !token} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {busy === "add" ? "Adding…" : "Add"}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground" style={{ marginTop: 8 }}>
          The board API key is stored server-side in plugin state and never sent back to the browser. Mint one on the
          remote with <code>POST /api/board-api-keys</code>.
        </p>
      </div>

      {/* Portfolio */}
      {portfolio.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          No remotes yet. Register one above — try your own instance for a self-federation test.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {portfolio.map((remote) => (
            <div key={remote.id} className="rounded-xl border border-border overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5 bg-muted/20">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block h-2 w-2 rounded-full ${remote.reachable ? "bg-emerald-500" : "bg-red-500"}`} />
                  <span className="font-semibold text-foreground truncate">{remote.label}</span>
                  <span className="text-[11px] text-muted-foreground truncate">{remote.baseUrl}</span>
                  {remote.version ? <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">v{remote.version}</span> : null}
                </div>
                <button type="button" onClick={() => onRemove(remote.id)} disabled={busy === `remove-${remote.id}`} className="text-[11px] text-muted-foreground hover:text-destructive">
                  Remove
                </button>
              </div>
              {!remote.reachable ? (
                <div className="px-4 py-3 text-sm text-destructive">{remote.error ?? "Unreachable"}</div>
              ) : (remote.companies ?? []).length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">No companies visible to this key.</div>
              ) : (
                <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
                  {(remote.companies ?? []).map((c) => (
                    <a key={c.id} href={c.deepLink} target="_blank" rel="noreferrer" className="rounded-lg border border-border p-3 hover:border-primary/50 transition-colors" style={{ textDecoration: "none" }}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground truncate">{c.name}</span>
                        <span className="text-[10px] text-muted-foreground">{c.issuePrefix}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
                        <Stat label="running" value={c.running} tone={c.running ? "cyan" : "muted"} />
                        <Stat label="queued" value={c.queued} tone="muted" />
                        <Stat label="needs you" value={c.needsYou} tone={c.needsYou ? "amber" : "muted"} />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground" style={{ marginTop: 8 }}>
                        <span>{c.agentCount} agents · {c.issueCount} tasks</span>
                        <span>{usd(c.spentCents)}{c.budgetCents ? ` / ${usd(c.budgetCents)}` : ""}</span>
                      </div>
                      <div className="text-[11px] text-primary" style={{ marginTop: 6 }}>Open in remote →</div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const TONES: Record<string, string> = {
  cyan: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  muted: "bg-muted text-muted-foreground",
};

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone] ?? TONES.muted}`}>
      <span className="font-semibold">{value}</span>
      {label}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  borderRadius: 6,
  border: "1px solid var(--border, #ced4da)",
  background: "transparent",
  padding: "6px 10px",
  fontSize: 13,
  width: 160,
  outline: "none",
};
