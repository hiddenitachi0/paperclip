import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WEB_SEARCH_FREE_CREDIT_TEXT,
  WEB_SEARCH_PRICE_TEXT,
  type CompanySecret,
} from "@paperclipai/shared";
import { AlertCircle, CheckCircle2, Globe } from "lucide-react";
import { webSearchApi } from "../api/webSearch";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretBindingPicker } from "./SecretBindingPicker";

/** Brave keys first (by kind, else by name), then everything else. */
export function rankBraveSecret(secret: CompanySecret): number {
  if (secret.kind === "brave_search_api_key") return 0;
  if (/brave/i.test(secret.name)) return 1;
  return 2;
}

/**
 * Connections → Web search: which saved secret is the company's Brave Search
 * key, and how many searches its quick agents made today. The quick agents
 * that may use it are the ones with "Can search the web" switched on in their
 * own Quick agent settings.
 */
export function WebSearchSection({ companyId, readOnly }: { companyId: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.webSearch(companyId),
    queryFn: () => webSearchApi.get(companyId),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (secretId: string | null) => webSearchApi.setKey(companyId, secretId),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.companies.webSearch(companyId), settings);
      pushToast({
        title: settings.keySecretId ? "Web search key saved" : "Web search key removed",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof ApiError ? error.message : "Could not save the web search key",
        tone: "error",
      });
    },
  });
  const settings = settingsQuery.data;

  return (
    <Card data-testid="connections-web-search">
      <CardHeader>
        <div className="flex items-start gap-2">
          <Globe className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="space-y-1">
            <CardTitle className="text-sm">Web search (Brave Search)</CardTitle>
            <CardDescription>
              Lets quick agents look up live facts on the web, such as scores, prices and news, and read the pages
              they find. Only quick agents with "Can search the web" switched on in their own settings use it. Brave
              charges {WEB_SEARCH_PRICE_TEXT} and gives {WEB_SEARCH_FREE_CREDIT_TEXT}. Get a key at
              api-dashboard.search.brave.com. Any saved secret can be picked, whatever kind it was saved as.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {settingsQuery.isError ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Could not load the web search settings: {(settingsQuery.error as Error).message}
          </p>
        ) : !settings ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="text-xs" data-testid="web-search-status">
              {settings.keyStatus === "ok" ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Using "{settings.keySecretName}"
                </span>
              ) : settings.keyStatus === "unusable" ? (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" /> The picked key is deleted or switched off. Pick another one.
                </span>
              ) : (
                <span className="text-muted-foreground">No key picked yet, so quick agents cannot search the web.</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="web-search-usage">
              Searches today: {settings.usedToday} of {settings.dailyCap}. Paperclip stops at {settings.dailyCap}{" "}
              searches a day for the whole company (at most about ${((settings.dailyCap * 5) / 1000).toFixed(2)} a
              day); searching works again after midnight UTC.
            </p>
            {readOnly ? (
              <p className="text-xs text-muted-foreground">Only the company owner or an admin can pick the key.</p>
            ) : (
              <SecretBindingPicker
                label="Brave Search key"
                placeholder="Pick the Brave Search key"
                value={settings.keySecretId ? { secretId: settings.keySecretId } : null}
                onChange={(next) => mutation.mutate(next?.secretId ?? null)}
                allowVersionSelector={false}
                disabled={mutation.isPending}
                rankSecret={rankBraveSecret}
                emptyHint="No saved keys yet. Add the Brave key here; choose Brave Search API key as its kind."
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
