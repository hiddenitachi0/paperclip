import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { jobsApi, type AddFromCatalogueResult, type PositionCatalogueItem } from "../../api/jobs";
import { ApiError } from "../../api/client";
import { useToastActions } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5 (most capable)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (balanced)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (fast and low-cost)",
  "claude-fable-5-1": "Claude Fable 5.1 (top tier, costliest)",
};

const EFFORT_NAMES: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra high",
  max: "maximum",
};

/** "Claude Sonnet 5.5 (balanced), medium thinking" — plain words for the suggested setup. */
export function describeSuggestedSetup(item: Pick<PositionCatalogueItem, "suggestedModel" | "suggestedEffort">): string {
  const model = MODEL_NAMES[item.suggestedModel] ?? item.suggestedModel;
  const effort = EFFORT_NAMES[item.suggestedEffort] ?? item.suggestedEffort;
  return `${model}, ${effort} thinking`;
}

/** The toast text after adding a position, in plain words. */
export function describeAddResult(name: string, result: AddFromCatalogueResult): string {
  const parts: string[] = [];
  parts.push(result.createdPosition ? `${name} is ready to hire.` : `${name} was already here; nothing in it was changed.`);
  const jobCount = result.createdJobs.length + result.linkedJobs.length;
  if (jobCount > 0) parts.push(`${jobCount} one-click ${jobCount === 1 ? "job" : "jobs"} added.`);
  if (result.installedSkills.length > 0) {
    parts.push(`${result.installedSkills.length} ${result.installedSkills.length === 1 ? "skill" : "skills"} installed.`);
  }
  if (result.warnings.length > 0) parts.push(result.warnings.join(" "));
  return parts.join(" ");
}

export function PositionCatalogueDialog({
  companyId,
  open,
  onOpenChange,
  onAdded,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const queryKey = ["position-catalogue", companyId] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => jobsApi.listCatalogue(companyId),
    enabled: open,
  });

  const add = useMutation({
    mutationFn: (item: PositionCatalogueItem) => jobsApi.addFromCatalogue(companyId, item.key),
    onSuccess: (result, item) => {
      queryClient.invalidateQueries({ queryKey });
      onAdded();
      pushToast({
        title: result.createdPosition ? "Position added" : "Position already added",
        body: describeAddResult(item.name, result),
        tone: result.warnings.length > 0 ? "warn" : "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Could not add position",
        body: err instanceof ApiError || err instanceof Error ? err.message : "",
        tone: "error",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a ready-made position</DialogTitle>
          <DialogDescription>
            Each position comes with starting instructions, the skills the work needs, and one-click jobs. Adding one only
            creates the position — you still choose which agent to place in it, and you can change everything afterwards.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load the list of ready-made positions.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(data ?? []).map((item) => (
              <li key={item.key} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{item.name}</div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Suggested brain: {describeSuggestedSetup(item)}. {item.modelReason}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.skillKeys.length} skills · {item.jobs.length} one-click{" "}
                    {item.jobs.length === 1 ? "job" : "jobs"}
                    {item.jobs.length > 0 ? `: ${item.jobs.map((job) => job.title).join(", ")}` : ""}
                  </p>
                  {item.suggestedConnections.length > 0 ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Works best when connected to: {item.suggestedConnections.join("; ")}
                    </p>
                  ) : null}
                </div>
                {item.alreadyAdded ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Check className="h-3.5 w-3.5" />
                    Added
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={add.isPending}
                    onClick={() => add.mutate(item)}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
