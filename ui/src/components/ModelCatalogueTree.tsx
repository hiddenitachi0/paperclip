import type { ReactNode } from "react";
import type { CreateModelDirectoryEntry, ModelDirectoryEntry } from "@paperclipai/shared";
import { ArrowUpCircle, ClipboardCopy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsSection, SettingsSubsection } from "./SettingsSection";
import {
  gpuFitLabel,
  UNSPECIFIED_VARIANT,
  type FamilyNode,
  type GpuFit,
  type KnownRunOption,
  type MakerNode,
  type UpgradeOption,
  type VariantNode,
} from "../lib/model-catalogue";

/**
 * Settings > Models as Maker > Model > Size > ways to run it. Saved setups are
 * the full rows (rendered by the page); ways the built-in model list knows of
 * but that are not saved yet are short rows with an "Add this way to run it"
 * button that opens the add dialog already filled in.
 */

type Entry = ModelDirectoryEntry;

export interface ModelCatalogueTreeProps {
  makers: MakerNode<Entry>[];
  canManage: boolean;
  /** Whether the graphics card size is known (fit advice needs it). */
  gpuKnown: boolean;
  renderRow: (entry: Entry) => ReactNode;
  onAdd: (draft: CreateModelDirectoryEntry) => void;
  onCopyText: (text: string, what: string) => void;
}

function testIdPart(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function FitBadge({ fit }: { fit: GpuFit | null }) {
  if (!fit) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 text-[11px] leading-5",
        fit === "yes" && "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
        fit === "tight" && "border-amber-500/50 text-amber-700 dark:text-amber-400",
        fit === "no" && "border-red-500/40 text-red-700 dark:text-red-400",
      )}
    >
      {gpuFitLabel(fit)}
    </span>
  );
}

function CopyCommand({ command, onCopyText }: { command: string; onCopyText: (text: string, what: string) => void }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{command}</code>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label={`Copy ${command}`}
        title="Copy the command, then paste it in a terminal on your PC"
        onClick={() => onCopyText(command, "Install command")}
      >
        <ClipboardCopy className="h-3 w-3" />
      </button>
    </span>
  );
}

function KnownOptionRow({
  option,
  canManage,
  onAdd,
  onCopyText,
}: {
  option: KnownRunOption;
  canManage: boolean;
  onAdd: (draft: CreateModelDirectoryEntry) => void;
  onCopyText: (text: string, what: string) => void;
}) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-1.5"
      data-testid={`models-known-${testIdPart(option.key)}`}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-medium">{option.label}</p>
        <p className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <code className="truncate font-mono">{option.model}</code>
          {option.pullCommand && (
            <>
              <span>· not saved yet · install with</span>
              <CopyCommand command={option.pullCommand} onCopyText={onCopyText} />
            </>
          )}
        </p>
      </div>
      {canManage && (
        <Button size="xs" variant="outline" onClick={() => onAdd(option.draft)}>
          <Plus /> Add this way to run it
        </Button>
      )}
    </li>
  );
}

function UpgradeRow({
  upgrade,
  canManage,
  onAdd,
}: {
  upgrade: UpgradeOption;
  canManage: boolean;
  onAdd: (draft: CreateModelDirectoryEntry) => void;
}) {
  const where = [
    upgrade.local ? "fits on your PC" : upgrade.fit === "no" ? "too big for your PC" : null,
    upgrade.openrouter ? `OpenRouter: ${upgrade.openrouter.hosts?.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 text-xs"
      data-testid={`models-upgrade-${testIdPart(upgrade.key)}`}
    >
      <span className="min-w-0">
        <span className="font-medium">
          {upgrade.family} {upgrade.variant}
        </span>
        {where && <span className="text-muted-foreground"> · {where}</span>}
        {upgrade.saved && <span className="text-muted-foreground"> · already saved</span>}
      </span>
      {canManage && (
        <span className="flex flex-wrap gap-1">
          {upgrade.local && (
            <Button size="xs" variant="outline" onClick={() => onAdd(upgrade.local!.draft)}>
              <Plus /> Add on your PC
            </Button>
          )}
          {upgrade.openrouter && (
            <Button size="xs" variant="outline" onClick={() => onAdd(upgrade.openrouter!.draft)}>
              <Plus /> Add via OpenRouter
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

function SizeBody({
  variant,
  familyTitle,
  canManage,
  gpuKnown,
  renderRow,
  onAdd,
  onCopyText,
}: Omit<ModelCatalogueTreeProps, "makers"> & { variant: VariantNode<Entry>; familyTitle: string }) {
  const known = variant.known;
  const hasLocalWay = Boolean(known && known.ollama.length > 0);
  return (
    <div className="space-y-2">
      {known && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid={`models-size-status-${variant.key}`}>
          <FitBadge fit={variant.fit} />
          {variant.installedLocally && <span>Installed on your PC</span>}
          {!variant.installedLocally && variant.pullCommand && (
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
              Not on your PC yet. To install it: <CopyCommand command={variant.pullCommand} onCopyText={onCopyText} />
            </span>
          )}
          {!hasLocalWay && <span>Not available for Ollama.</span>}
          {!gpuKnown && hasLocalWay && known.minVramGb !== null && (
            <span>Needs about {known.minVramGb} GB of graphics memory.</span>
          )}
        </div>
      )}
      {variant.tooBigAdvice && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`models-too-big-${variant.key}`}>
          {variant.tooBigAdvice}
        </p>
      )}
      {known?.note && <p className="text-xs text-muted-foreground">{known.note}</p>}

      {variant.entries.length > 0 ? (
        <ul className="space-y-2">{variant.entries.map(renderRow)}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          You have not saved {familyTitle} {variant.title} yet.
        </p>
      )}

      {variant.knownOptions.length > 0 && (
        <div className="space-y-1.5" data-testid={`models-known-options-${variant.key}`}>
          <p className="text-xs font-medium text-muted-foreground">
            {variant.entries.length > 0 ? "Other ways to run it" : "Ways to run it"}
          </p>
          <ul className="space-y-1.5">
            {variant.knownOptions.map((option) => (
              <KnownOptionRow key={option.key} option={option} canManage={canManage} onAdd={onAdd} onCopyText={onCopyText} />
            ))}
          </ul>
        </div>
      )}

      {variant.upgrades.length > 0 && (
        <div
          className="space-y-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2"
          data-testid={`models-upgrades-${variant.key}`}
        >
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <ArrowUpCircle className="h-3.5 w-3.5 text-sky-600" /> Upgrade: bigger versions of this model
          </p>
          <ul className="space-y-1">
            {variant.upgrades.map((upgrade) => (
              <UpgradeRow key={upgrade.key} upgrade={upgrade} canManage={canManage} onAdd={onAdd} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function sizeSummary(variant: VariantNode<Entry>): string {
  const parts: string[] = [];
  parts.push(variant.entries.length > 0 ? count(variant.entries.length, "saved way", "saved ways") : "not saved");
  if (variant.installedLocally) parts.push("installed");
  const fit = gpuFitLabel(variant.fit);
  if (fit) parts.push(fit.toLowerCase());
  return parts.join(" · ");
}

function FamilyBody(props: Omit<ModelCatalogueTreeProps, "makers"> & { family: FamilyNode<Entry> }) {
  const { family } = props;
  // A family with only "size not set" setups and nothing known needs no size level.
  if (family.variants.length === 1 && family.variants[0]!.title === UNSPECIFIED_VARIANT && !family.variants[0]!.known) {
    return <ul className="space-y-2">{family.variants[0]!.entries.map(props.renderRow)}</ul>;
  }
  return (
    <div className="space-y-3 border-l border-border pl-3">
      {family.variants.map((variant) => (
        <SettingsSubsection
          key={variant.key}
          title={variant.title === UNSPECIFIED_VARIANT ? "Size not set" : `${family.unset ? "" : `${family.title} `}${variant.title}`}
          summary={sizeSummary(variant)}
          defaultOpen={variant.entries.length > 0}
          storageKey={`models.size.${variant.key}`}
          data-testid={`models-size-${variant.key}`}
        >
          <SizeBody {...props} variant={variant} familyTitle={family.title} />
        </SettingsSubsection>
      ))}
    </div>
  );
}

export function ModelCatalogueTree({ makers, ...props }: ModelCatalogueTreeProps) {
  return (
    <div className="space-y-6" data-testid="models-list">
      {makers.map((maker) => (
        <SettingsSection
          key={maker.key}
          title={maker.title}
          summary={`${count(maker.families.length, "model", "models")} · ${count(maker.entries.length, "saved setup", "saved setups")}`}
          storageKey={`models.group.${maker.key}`}
          contentClassName="space-y-4"
          data-testid={`models-group-${maker.key}`}
        >
          {maker.families.map((family) => {
            const sizes = family.variants.filter((variant) => variant.title !== UNSPECIFIED_VARIANT).length;
            return (
              <SettingsSubsection
                key={family.key}
                title={family.title}
                summary={[
                  sizes > 0 ? count(sizes, "size", "sizes") : null,
                  count(family.entries.length, "saved setup", "saved setups"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                storageKey={`models.family.${family.key}`}
                data-testid={`models-family-${family.key}`}
              >
                <FamilyBody {...props} family={family} />
              </SettingsSubsection>
            );
          })}
        </SettingsSection>
      ))}
    </div>
  );
}
