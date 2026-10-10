import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { companyMigrationNameMatches, markCompanyMigratedSchema, type Company } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { companiesApi } from "../../api/companies";
import { useCompanyRole } from "../../hooks/useCompanyRole";
import { queryKeys } from "../../lib/queryKeys";
import { MigrationVerifyPanel } from "./MigrationVerifyPanel";

/**
 * Company settings → "Moving this company". Two halves of the safe two-phase
 * cutover:
 *   - on the NEW Paperclip: "Verify destination" (read-only checklist);
 *   - on the OLD one: "Mark as migrated" (owner/admin, two confirmations),
 *     which pauses agents and routines and shows the "has moved" banner, and
 *     "Undo: resume here". Nothing is ever deleted.
 */
export function MoveCompanySection({ company }: { company: Pick<Company, "id" | "name" | "migratedToUrl" | "migratedAt"> }) {
  const queryClient = useQueryClient();
  const role = useCompanyRole(company.id);
  const canManage = role.canManageConnections;
  const [showVerify, setShowVerify] = useState(false);
  const [destinationUrl, setDestinationUrl] = useState("");
  const [step, setStep] = useState<"idle" | "confirm">("idle");
  const [typedName, setTypedName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const markMutation = useMutation({
    mutationFn: () =>
      companiesApi.markMigrated(company.id, { destinationUrl: destinationUrl.trim(), confirmCompanyName: typedName }),
    onSuccess: async (result) => {
      setStep("idle");
      setTypedName("");
      setMessage(
        `Marked as moved. Paused ${result.agentsPaused} agent${result.agentsPaused === 1 ? "" : "s"} and ${
          result.routinesPaused
        } routine${result.routinesPaused === 1 ? "" : "s"}. Nothing was deleted.`,
      );
      await refresh();
    },
  });

  const undoMutation = useMutation({
    mutationFn: () => companiesApi.undoMigrated(company.id),
    onSuccess: async (result) => {
      setMessage(
        `Resumed here: ${result.agentsResumed} agent${result.agentsResumed === 1 ? "" : "s"} and ${
          result.routinesResumed
        } routine${result.routinesResumed === 1 ? "" : "s"} are running again.`,
      );
      await refresh();
    },
  });

  const urlCheck = markCompanyMigratedSchema.shape.destinationUrl.safeParse(destinationUrl);
  const urlError = destinationUrl.trim().length > 0 && !urlCheck.success ? urlCheck.error.issues[0]?.message : null;
  const nameOk = companyMigrationNameMatches(typedName, company.name);
  const error = markMutation.error ?? undoMutation.error;

  return (
    <div className="space-y-4" data-testid="move-company-section">
      <div className="section-title">Moving this company</div>
      <div className="space-y-4 rounded-md section-box px-4 py-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Just imported this company from another Paperclip? Check that everything arrived and works here.
          </p>
          {showVerify ? (
            <MigrationVerifyPanel companyId={company.id} />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setShowVerify(true)} data-testid="move-company-verify">
              Verify destination
            </Button>
          )}
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          {company.migratedToUrl ? (
            <>
              <p className="text-sm" data-testid="move-company-moved">
                This company has moved to{" "}
                <a href={company.migratedToUrl} target="_blank" rel="noreferrer" className="underline">
                  {company.migratedToUrl}
                </a>
                . Its agents and routines are paused here, and nothing has been deleted.
              </p>
              {canManage ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={undoMutation.isPending}
                  onClick={() => undoMutation.mutate()}
                  data-testid="move-company-undo"
                >
                  {undoMutation.isPending ? "Resuming..." : "Undo: resume here"}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Only the company's owner or an admin can undo this.</p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Moved this company to another Paperclip and checked it there? Mark this copy as moved. Its agents and
                routines are paused and everyone sees where the company lives now. Nothing is deleted, and you can undo
                it.
              </p>
              {!canManage ? (
                <p className="text-xs text-muted-foreground" data-testid="move-company-not-allowed">
                  Only the company's owner or an admin can mark it as moved.
                </p>
              ) : step === "idle" ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-[16rem] flex-1 text-xs">
                    <span className="text-muted-foreground">Address of the company on the new Paperclip</span>
                    <input
                      type="url"
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      placeholder="https://paperclip.example.com/ABC"
                      value={destinationUrl}
                      onChange={(e) => setDestinationUrl(e.target.value)}
                      data-testid="move-company-url"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!urlCheck.success}
                    onClick={() => {
                      setMessage(null);
                      setStep("confirm");
                    }}
                    data-testid="move-company-mark"
                  >
                    Mark as migrated...
                  </Button>
                  {urlError && <p className="w-full text-xs text-destructive">{urlError}</p>}
                </div>
              ) : (
                <div
                  className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3"
                  data-testid="move-company-confirm"
                >
                  <p className="text-sm font-medium">Are you sure?</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-xs">
                    <li>Every agent of {company.name} on this Paperclip is paused.</li>
                    <li>Every routine that is on is paused.</li>
                    <li>Everyone sees a banner: “This company has moved to {destinationUrl.trim()}”.</li>
                    <li>Nothing is deleted. “Undo: resume here” puts it all back.</li>
                  </ul>
                  <label className="block text-xs">
                    <span className="text-muted-foreground">Type the company's name ({company.name}) to confirm</span>
                    <input
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                      data-testid="move-company-typed-name"
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!nameOk || markMutation.isPending}
                      onClick={() => markMutation.mutate()}
                      data-testid="move-company-confirm-button"
                    >
                      {markMutation.isPending ? "Marking..." : "Yes, mark as moved"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setStep("idle");
                        setTypedName("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {message && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400" data-testid="move-company-message">
              {message}
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive">{error instanceof Error ? error.message : "That did not work."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
