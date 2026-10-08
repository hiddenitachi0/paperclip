import type { ReactNode } from "react";
import type { ModelDirectoryEntry } from "@paperclipai/shared";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Pencil,
  Star,
  Stethoscope,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModelReviewPanel } from "./ModelReviewPanel";
import {
  availabilityLabel,
  describeSpecs,
  duplicateLabel,
  laneLabel,
  noteFirstLine,
  ratingsAverage,
  runOptionLabel,
} from "../lib/model-catalogue";

/**
 * One saved model in the Settings > Models catalogue (one way to run a model
 * size): a compact row with the favourite star, name, how it runs ("Local ·
 * llama3.2:3b" / "OpenRouter · deepinfra"), chips, the company's test
 * scores, a one-line spec summary and the first line of the note. "More" opens the rest (full note, address, links,
 * defaults). Change buttons only show for the company owner and admins.
 */

function Chip({
  children,
  tone = "plain",
  title,
  testId,
}: {
  children: ReactNode;
  tone?: "plain" | "muted" | "warn";
  title?: string;
  testId?: string;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0 text-[11px] leading-5",
        tone === "plain" && "border-border text-foreground",
        tone === "muted" && "border-transparent bg-muted text-muted-foreground",
        tone === "warn" && "border-amber-500/50 text-amber-700 dark:text-amber-400",
      )}
    >
      {children}
    </span>
  );
}

function defaultsText(entry: ModelDirectoryEntry): string {
  const parts: string[] = [];
  if (entry.defaultThinking) parts.push(`thinking ${entry.defaultThinking}`);
  if (entry.defaultTemperature !== null) parts.push(`creativity ${entry.defaultTemperature}`);
  if (entry.defaultMaxOutputTokens !== null) parts.push(`longest answer ${entry.defaultMaxOutputTokens}`);
  return parts.join(" · ");
}

export function ModelCatalogueRow({
  entry,
  companyId,
  sameModelAs,
  canManage,
  expanded,
  checkingUp,
  busy,
  onToggleExpanded,
  onToggleCheckUp,
  onToggleFavorite,
  onEdit,
  onDuplicate,
  onToggleArchived,
  onDelete,
  onCopyText,
}: {
  entry: ModelDirectoryEntry;
  companyId: string;
  /** Names of other saved models that point at the very same model. */
  sameModelAs?: readonly string[];
  canManage: boolean;
  expanded: boolean;
  checkingUp: boolean;
  /** A change to this entry is on its way: its change buttons wait. */
  busy: boolean;
  onToggleExpanded: () => void;
  onToggleCheckUp: () => void;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onToggleArchived: () => void;
  onDelete: () => void;
  onCopyText: (text: string, what: string) => void;
}) {
  const archived = Boolean(entry.archivedAt);
  const ratings = entry.ratings ?? [];
  const average = ratingsAverage(ratings);
  const specs = describeSpecs(entry.specs);
  const note = noteFirstLine(entry.note);
  const defaults = defaultsText(entry);
  const pullCommand = entry.specs?.pullCommand?.trim() || null;
  const rawSourceUrl = entry.specs?.sourceUrl?.trim() || null;
  // Only real web links; an imported file could carry a javascript: link.
  const sourceUrl = rawSourceUrl && /^https?:\/\//i.test(rawSourceUrl) ? rawSourceUrl : null;
  const license = entry.specs?.license?.trim() || null;
  const hasMore = note.more || Boolean(entry.baseUrl || pullCommand || sourceUrl || license || defaults);

  return (
    <li
      data-testid={`model-card-${entry.id}`}
      data-archived={archived ? "true" : undefined}
      className={cn(
        "space-y-1.5 rounded-md border border-border px-3 py-2",
        archived && "border-dashed bg-muted/30 text-muted-foreground",
      )}
    >
      <div className="flex items-start gap-2">
        {canManage ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-pressed={entry.favorite}
            aria-label={entry.favorite ? "Remove from favourites" : "Add to favourites"}
            title={entry.favorite ? "Remove from favourites" : "Add to favourites"}
            disabled={busy}
            onClick={onToggleFavorite}
            data-testid={`model-favorite-${entry.id}`}
          >
            <Star className={cn("h-4 w-4", entry.favorite && "fill-amber-400 text-amber-500")} />
          </button>
        ) : (
          <span className="mt-0.5 w-5 shrink-0 p-0.5" aria-hidden={!entry.favorite}>
            {entry.favorite && <Star className="h-4 w-4 fill-amber-400 text-amber-500" aria-label="Favourite" />}
          </span>
        )}

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-sm font-semibold", archived ? "text-muted-foreground" : "text-foreground")}>
              {entry.name}
            </span>
            <Chip testId={`model-runs-${entry.id}`}>{runOptionLabel(entry)}</Chip>
            {entry.lane && <Chip>{laneLabel(entry.lane)}</Chip>}
            {entry.availability && <Chip tone="muted">{availabilityLabel(entry.availability)}</Chip>}
            {(entry.tags ?? []).map((tag) => (
              <Chip key={tag} tone="muted">
                #{tag}
              </Chip>
            ))}
            {sameModelAs && sameModelAs.length > 0 && (
              <Chip
                tone="warn"
                testId={`model-duplicate-${entry.id}`}
                title={`These setups use the very same model: ${sameModelAs.join(", ")}. That is fine if their defaults differ.`}
              >
                <AlertTriangle className="h-3 w-3" />
                {duplicateLabel(sameModelAs)}
              </Chip>
            )}
            {archived && (
              <Chip tone="muted" testId={`model-archived-${entry.id}`}>
                Archived
              </Chip>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <code className="truncate font-mono">{entry.model}</code>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 hover:text-foreground"
              aria-label="Copy model id"
              title="Copy model id"
              onClick={() => onCopyText(entry.model, "Model id")}
              data-testid={`model-copy-id-${entry.id}`}
            >
              <ClipboardCopy className="h-3 w-3" />
            </button>
          </div>

          {ratings.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" data-testid={`model-ratings-${entry.id}`}>
              {ratings.map((rating) => (
                <Chip key={rating.criterion} tone="muted" title={rating.note ?? undefined}>
                  {rating.criterion} {rating.score}
                </Chip>
              ))}
              {average !== null && ratings.length > 1 && (
                <span className="text-[11px] text-muted-foreground">average {average}</span>
              )}
            </div>
          )}

          {specs && (
            <p className="text-xs text-muted-foreground" data-testid={`model-specs-${entry.id}`}>
              {specs}
            </p>
          )}

          {(note.first || hasMore) && (
            <div className="text-xs text-muted-foreground">
              {!expanded && note.first && <span>{note.first} </span>}
              {hasMore && (
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={onToggleExpanded}
                  aria-expanded={expanded}
                  data-testid={`model-more-${entry.id}`}
                >
                  {expanded ? "Less" : "More"}
                </button>
              )}
            </div>
          )}

          {expanded && (
            <div className="space-y-1.5 text-xs text-muted-foreground" data-testid={`model-details-${entry.id}`}>
              {entry.note && <p className="whitespace-pre-wrap text-foreground/80">{entry.note}</p>}
              {entry.baseUrl && <p>Address: {entry.baseUrl}</p>}
              {defaults && <p>Defaults for agents: {defaults}</p>}
              {license && <p>Licence: {license}</p>}
              {sourceUrl && (
                <p>
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                  >
                    Model page <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              )}
              {pullCommand && (
                <p className="flex min-w-0 items-center gap-1">
                  Install: <code className="truncate font-mono text-foreground/80">{pullCommand}</code>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:text-foreground"
                    aria-label="Copy install command"
                    title="Copy install command"
                    onClick={() => onCopyText(pullCommand, "Install command")}
                  >
                    <ClipboardCopy className="h-3 w-3" />
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 pl-7">
        <Button size="xs" variant="ghost" onClick={onToggleCheckUp}>
          <Stethoscope /> {checkingUp ? "Hide check-up" : "Check-up"}
        </Button>
        {canManage && (
          <>
            <Button size="xs" variant="ghost" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={onDuplicate}>
              <Copy /> Make a copy
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={onToggleArchived}
              data-testid={`model-archive-${entry.id}`}
              title={
                archived
                  ? "Show it to agents again"
                  : "Hide it from agent pickers. It stays here and can be restored."
              }
            >
              {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Restore" : "Archive"}
            </Button>
            <Button size="xs" variant="ghost" onClick={onDelete}>
              <Trash2 /> Delete
            </Button>
          </>
        )}
      </div>

      {checkingUp && (
        <div className="pl-7">
          <ModelReviewPanel companyId={companyId} entryId={entry.id} canManage={canManage} />
        </div>
      )}
    </li>
  );
}
