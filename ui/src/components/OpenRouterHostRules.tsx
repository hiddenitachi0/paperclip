import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  OPENROUTER_HOST_RULES_MAX,
  OPENROUTER_HOST_SLUG_RE,
  type ModelDirectoryEntry,
  type ModelDirectorySettings,
} from "@paperclipai/shared";
import { X } from "lucide-react";
import { modelDirectoryApi } from "../api/modelDirectory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpTip, MODEL_HELP } from "./ModelHelp";
import { modelSettingsQueryKey } from "./ModelLocalSync";

/**
 * Settings > Models > OpenRouter hosts: the company's preferred and blocked
 * hosts. Owner/admin edit (saved at once); everyone else reads them as text.
 * What the lists do and which wins is spelled out on the page, because it is
 * not obvious: see OPENROUTER_HOST_RULES_HELP and
 * packages/shared/src/openrouter-hosts.ts.
 */

export const OPENROUTER_HOST_RULES_HELP = {
  intro:
    "A host is a company that actually runs a model for OpenRouter (OpenRouter itself only passes the request on). The same model is often run by several hosts, at different prices, and what each one supports differs per model: a host can support tool calling for one model and not for another. Open a model setup to see its hosts.",
  preferred:
    "Hosts you trust. A new OpenRouter model setup uses only these, if at least one of them runs that model with tool calling; otherwise OpenRouter chooses as usual.",
  blocked:
    "Hosts never to use. They are added to every OpenRouter model setup's Never list when it is saved, also for models they do not run today.",
  precedence:
    "Which wins: what a model setup says itself comes first. A host marked Use on a setup is used even if it is on the blocked list here (a deliberate exception), and a setup with any host marked Use ignores the preferred list. Hosts left on Default follow these lists. Setups saved before a change keep their own lists until they are opened and saved again.",
};

/** Host names the company already uses or has seen in its OpenRouter setups, for the suggestions. */
export function hostSlugsInUse(entries: readonly ModelDirectoryEntry[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.provider !== "openrouter") continue;
    for (const slug of entry.providerRouting?.only ?? []) out.add(slug);
    for (const slug of entry.providerRouting?.ignore ?? []) out.add(slug);
    for (const seen of entry.specs?.openrouterHostsSeen ?? []) out.add(seen.slug);
  }
  return [...out].filter((slug) => OPENROUTER_HOST_SLUG_RE.test(slug)).sort();
}

function HostList({
  id,
  title,
  help,
  hosts,
  other,
  otherTitle,
  suggestions,
  canManage,
  pending,
  onChange,
}: {
  id: string;
  title: string;
  help: string;
  hosts: readonly string[];
  other: readonly string[];
  otherTitle: string;
  suggestions: readonly string[];
  canManage: boolean;
  pending: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const slugs = draft
      .split(/[\s,]+/)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (slugs.length === 0) return;
    const bad = slugs.find((slug) => !OPENROUTER_HOST_SLUG_RE.test(slug));
    if (bad) {
      setProblem(`"${bad}" is not a host name. Use the short lower-case name OpenRouter shows, letters, digits and dashes only.`);
      return;
    }
    const clash = slugs.find((slug) => other.includes(slug));
    if (clash) {
      setProblem(`${clash} is already on the ${otherTitle.toLowerCase()} list. Take it off there first.`);
      return;
    }
    const next = [...new Set([...hosts, ...slugs])];
    if (next.length > OPENROUTER_HOST_RULES_MAX) {
      setProblem(`List at most ${OPENROUTER_HOST_RULES_MAX} hosts.`);
      return;
    }
    setProblem(null);
    setDraft("");
    onChange(next);
  };
  return (
    <div className="space-y-1" data-testid={`${id}`}>
      <div className="text-xs font-medium">{title}</div>
      <p className="text-xs text-muted-foreground">{help}</p>
      {hosts.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`${id}-empty`}>
          None.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1" data-testid={`${id}-chips`}>
          {hosts.map((slug) => (
            <span
              key={slug}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-xs"
            >
              {slug}
              {canManage && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${slug}`}
                  disabled={pending}
                  onClick={() => onChange(hosts.filter((host) => host !== slug))}
                  data-testid={`${id}-remove-${slug}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            className="h-8 max-w-56 font-mono text-xs"
            list={`${id}-options`}
            value={draft}
            placeholder="host name"
            aria-label={`Add to ${title.toLowerCase()}`}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            data-testid={`${id}-input`}
          />
          <datalist id={`${id}-options`}>
            {suggestions
              .filter((slug) => !hosts.includes(slug) && !other.includes(slug))
              .map((slug) => (
                <option key={slug} value={slug} />
              ))}
          </datalist>
          <Button type="button" size="xs" variant="outline" disabled={pending || !draft.trim()} onClick={add} data-testid={`${id}-add`}>
            Add host
          </Button>
        </div>
      )}
      {problem && (
        <p className="text-xs text-destructive" data-testid={`${id}-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
}

export function OpenRouterHostRules({
  companyId,
  settings,
  entries,
  canManage,
  onError,
}: {
  companyId: string;
  settings: ModelDirectorySettings | undefined;
  entries: readonly ModelDirectoryEntry[];
  canManage: boolean;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const preferred = settings?.openrouterPreferredHosts ?? [];
  const blocked = settings?.openrouterBlockedHosts ?? [];
  const mutation = useMutation({
    mutationFn: (body: { openrouterPreferredHosts?: string[]; openrouterBlockedHosts?: string[] }) =>
      modelDirectoryApi.updateSettings(companyId, body),
    onSuccess: (next) => queryClient.setQueryData(modelSettingsQueryKey(companyId), next),
    onError,
  });
  const suggestions = hostSlugsInUse(entries);
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="models-openrouter-hosts">
      <div className="space-y-0.5">
        <p className="inline-flex items-center gap-1 text-sm font-medium">
          OpenRouter hosts
          <HelpTip topic="openrouter hosts" text={MODEL_HELP.hostRules} />
        </p>
        <p className="text-xs text-muted-foreground">{OPENROUTER_HOST_RULES_HELP.intro}</p>
      </div>
      <HostList
        id="models-hosts-preferred"
        title="Preferred hosts"
        help={OPENROUTER_HOST_RULES_HELP.preferred}
        hosts={preferred}
        other={blocked}
        otherTitle="Blocked hosts"
        suggestions={suggestions}
        canManage={canManage}
        pending={mutation.isPending}
        onChange={(next) => mutation.mutate({ openrouterPreferredHosts: next })}
      />
      <HostList
        id="models-hosts-blocked"
        title="Blocked hosts"
        help={OPENROUTER_HOST_RULES_HELP.blocked}
        hosts={blocked}
        other={preferred}
        otherTitle="Preferred hosts"
        suggestions={suggestions}
        canManage={canManage}
        pending={mutation.isPending}
        onChange={(next) => mutation.mutate({ openrouterBlockedHosts: next })}
      />
      <p className="text-xs text-muted-foreground" data-testid="models-hosts-precedence">
        {OPENROUTER_HOST_RULES_HELP.precedence}
      </p>
    </div>
  );
}
