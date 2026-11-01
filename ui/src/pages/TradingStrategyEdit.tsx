import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { TRADING_ASSETS, type TradingStrategySpec } from "@paperclipai/shared";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { tradingApi, type ProposeVersionResult } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { checkRuleBook, normalizeSpec, parseStoredSpec, starterSpec } from "../lib/tradingRuleBook";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "../components/PageSkeleton";
import { TradingStrategyEditor } from "../components/TradingStrategyEditor";
import { TradingDisclaimer } from "../components/TradingDisclaimer";

/**
 * One screen for adding a strategy and for changing one. Saving never
 * changes anything that is running: it files a new version and a card, and
 * the screen then says "Waiting for approval" until someone approves the card.
 */

export const WAITING_FOR_APPROVAL = "Waiting for approval";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const issues = (error.body as { details?: { issues?: Array<{ path: string; message: string }> } } | null)?.details?.issues;
    if (issues && issues.length > 0) return issues.map((i) => i.message).join(" ");
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

type Saved = { kind: "waiting"; approvalId: string | null; versionNumber: number } | { kind: "unchanged" };

export function TradingStrategyEdit() {
  const { strategyId } = useParams<{ strategyId?: string }>();
  const mode: "create" | "edit" = strategyId ? "edit" : "create";
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const role = useCompanyRole(selectedCompanyId);

  const [spec, setSpec] = useState<TradingStrategySpec | null>(mode === "create" ? starterSpec("", "BTC", "4h") : null);
  const [guidelines, setGuidelines] = useState("");
  const [cash, setCash] = useState(3000);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  const strategiesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.trading.list(selectedCompanyId) : ["trading-strategies", "__none__"],
    queryFn: () => tradingApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && mode === "edit",
  });
  const strategy = (strategiesQuery.data ?? []).find((s) => s.id === strategyId) ?? null;

  const versionsQuery = useQuery({
    queryKey: selectedCompanyId && strategyId ? queryKeys.trading.versions(selectedCompanyId, strategyId) : ["trading-versions", "__none__"],
    queryFn: () => tradingApi.versions(selectedCompanyId!, strategyId!),
    enabled: Boolean(selectedCompanyId && strategyId),
  });
  const versions = versionsQuery.data ?? [];
  const live = versions.find((v) => v.status === "approved") ?? null;
  const waiting = versions.find((v) => v.status === "draft") ?? null;

  useEffect(() => {
    setBreadcrumbs(
      mode === "create"
        ? [{ label: "Trading", href: "/trading" }, { label: "New strategy" }]
        : [{ label: "Trading", href: "/trading" }, { label: strategy?.name ?? "Strategy", href: `/trading/${strategyId}` }, { label: "Change rules" }],
    );
  }, [setBreadcrumbs, mode, strategy?.name, strategyId]);

  // Edit: start from the version still waiting for approval if there is one (so a person never loses what they just wrote), else from the rules running now.
  const startFrom = waiting ?? live;
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const loadProblem = mode === "edit" && startFrom && parseStoredSpec(startFrom.spec) === null;
  useEffect(() => {
    if (mode !== "edit" || !startFrom || loadedFrom !== null) return;
    const parsed = parseStoredSpec(startFrom.spec);
    if (!parsed) return;
    setSpec(parsed);
    setGuidelines(startFrom.guidelines);
    setLoadedFrom(startFrom.id);
  }, [mode, startFrom, loadedFrom]);

  const check = useMemo(() => (spec ? checkRuleBook(spec, guidelines) : null), [spec, guidelines]);

  const save = useMutation({
    mutationFn: async (): Promise<{ result: ProposeVersionResult; strategyId: string; created: boolean }> => {
      if (!spec || !check || !check.ok) throw new Error("These rules are not ready to save yet.");
      const companyId = selectedCompanyId!;
      if (mode === "create") {
        const created = await tradingApi.create(companyId, {
          name: spec.meta.name.trim(),
          asset: spec.universe.assets[0]!,
          timeframe: spec.universe.decisionTimeframe,
          startingCashNok: Math.round(cash),
        });
        try {
          const result = await tradingApi.proposeVersion(companyId, created.id, check.book);
          return { result, strategyId: created.id, created: true };
        } catch (error) {
          // The strategy exists (paused, with simple starter rules); take the person to it so nothing is lost.
          queryClient.invalidateQueries({ queryKey: queryKeys.trading.list(companyId) });
          navigate(`/trading/${created.id}/edit`);
          throw error;
        }
      }
      const result = await tradingApi.proposeVersion(companyId, strategyId!, check.book);
      return { result, strategyId: strategyId!, created: false };
    },
    onSuccess: ({ result, strategyId: id, created }) => {
      const companyId = selectedCompanyId!;
      queryClient.invalidateQueries({ queryKey: queryKeys.trading.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.trading.versions(companyId, id) });
      if (result.outcome === "unchanged") {
        setSaved({ kind: "unchanged" });
        return;
      }
      setSaved({ kind: "waiting", approvalId: result.approvalId, versionNumber: result.version.version });
      pushToast({
        title: created ? "Strategy added" : "Change saved",
        body: `${WAITING_FOR_APPROVAL}. Nothing changes until it is approved.`,
        tone: "success",
      });
      if (created) navigate(`/trading/${id}`);
    },
    onError: (error) => pushToast({ title: "Could not save the rules", body: errorMessage(error, "Try again in a moment."), tone: "error" }),
  });

  if (!role.canManageConnections && mode === "create") {
    return <div className="py-6 text-sm text-muted-foreground">Only a company owner or admin can add a strategy.</div>;
  }
  if (mode === "edit" && (strategiesQuery.isLoading || versionsQuery.isLoading)) return <PageSkeleton variant="dashboard" />;
  if (mode === "edit" && !strategy) return <div className="py-6 text-sm text-muted-foreground">Strategy not found.</div>;
  if (mode === "edit" && !role.canManageConnections) {
    return <div className="py-6 text-sm text-muted-foreground">Only a company owner or admin can change a strategy's rules.</div>;
  }
  if (loadProblem) {
    return <div className="py-6 text-sm text-destructive">The saved rules of this strategy could not be read, so they cannot be edited here.</div>;
  }
  if (!spec) return <PageSkeleton variant="dashboard" />;

  const canSave = check?.ok === true && !save.isPending && saved === null && (mode === "create" ? TRADING_ASSETS.includes(spec.universe.assets[0]!) && cash > 0 : true);

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-testid="strategy-edit-page">
      <div>
        <h1 className="text-lg font-semibold">{mode === "create" ? "New strategy" : `Change the rules of ${strategy?.name ?? "this strategy"}`}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "create"
            ? "Describe how it should trade, in plain terms. It starts paused and uses play money only."
            : "Saving does not change anything that is running. It creates a new version that needs your approval first."}
        </p>
        <div className="mt-1">
          <TradingDisclaimer />
        </div>
      </div>

      {mode === "edit" && waiting && saved === null ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="strategy-waiting-note">
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            You are changing version {waiting.version}, which is {WAITING_FOR_APPROVAL.toLowerCase()}. If you save, it is replaced by the new version.
          </p>
        </div>
      ) : null}

      <TradingStrategyEditor
        mode={mode}
        spec={spec}
        guidelines={guidelines}
        onSpecChange={(next) => setSpec(normalizeSpec(next))}
        onGuidelinesChange={setGuidelines}
        startingCashNok={mode === "create" ? cash : undefined}
        onStartingCashChange={mode === "create" ? setCash : undefined}
      />

      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="strategy-save-area">
        {saved === null ? (
          <>
            <p className="text-sm text-muted-foreground">
              {mode === "create"
                ? "Saving adds the strategy (paused) and files your rules for approval. Until they are approved it uses simple starter rules."
                : "Saving files these rules for approval. The strategy keeps trading on the current rules until you approve."}
            </p>
            {check && !check.ok && showProblems ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-destructive" data-testid="strategy-problems">
                {check.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  if (!check?.ok) {
                    setShowProblems(true);
                    return;
                  }
                  save.mutate();
                }}
                disabled={save.isPending || (check?.ok === true && !canSave)}
              >
                {save.isPending ? "Saving…" : mode === "create" ? "Add strategy and ask for approval" : "Save and ask for approval"}
              </Button>
              <Button variant="outline" onClick={() => navigate(mode === "create" ? "/trading" : `/trading/${strategyId}`)} disabled={save.isPending}>
                Cancel
              </Button>
            </div>
          </>
        ) : saved.kind === "unchanged" ? (
          <>
            <p className="text-sm font-medium">Nothing changed.</p>
            <p className="text-sm text-muted-foreground">These rules are the same as the ones already running, so there is nothing to approve.</p>
            <Button variant="outline" onClick={() => navigate(`/trading/${strategyId}`)}>
              Back to the strategy
            </Button>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-sm font-medium" data-testid="strategy-waiting">
              <Clock className="h-4 w-4" />
              {WAITING_FOR_APPROVAL}
            </p>
            <p className="text-sm text-muted-foreground">
              Version {saved.versionNumber} is saved. The strategy keeps trading on its current rules until a card is approved.
            </p>
            <div className="flex flex-wrap gap-2">
              {saved.approvalId ? (
                <Button asChild>
                  <Link to={`/approvals/${saved.approvalId}`}>Open the approval card</Link>
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => navigate(`/trading/${strategyId}`)}>
                Back to the strategy
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
