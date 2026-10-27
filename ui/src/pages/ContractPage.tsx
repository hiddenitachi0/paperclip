import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileText, FileWarning, Pencil, Plus, Trash2 } from "lucide-react";
import {
  contractsApi,
  type ContractDeadline,
  type ContractDetail,
  type ContractTerm,
} from "../api/contracts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCanUseContracts } from "../hooks/useCanUseContracts";
import { queryKeys } from "../lib/queryKeys";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TEXT_STATUS_HELP,
  CONTRACT_TEXT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DEADLINE_KIND_LABELS,
  DEADLINE_SOON_DAYS,
  DEADLINE_STATE_LABELS,
  daysUntil,
  describeDaysUntil,
  formatDay,
  formatTermValue,
  isContractLive,
  partyDisplayName,
  termLabel,
} from "../lib/contract-labels";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import {
  ContractFactsDialog,
  DeadlineDialog,
  LinkVersionDialog,
  PartyDialog,
  TermDialog,
} from "../components/legal/ContractDialogs";
import {
  deadlineInputFromDraft,
  describeRemindDays,
  factsUpdate,
  termInputFromDraft,
  termKeyFromDraft,
} from "../components/legal/contract-forms";
import { errorText } from "./Legal";

/**
 * One contract: the file, a short summary, who is on it, the key terms with
 * where they sit in the contract, the dates that matter, and the history of
 * versions. The board can correct any of it.
 */

function Section({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="space-y-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

function renewalText(contract: ContractDetail): string {
  if (contract.autoRenewal === true) return "Yes, it renews by itself";
  if (contract.autoRenewal === false) return "No";
  return "Not known";
}

function deadlineWhen(deadline: ContractDeadline): string {
  return `${formatDay(deadline.dueDate)} (${describeDaysUntil(deadline.dueDate)})`;
}

/** One place for "save, refresh, close, tell the person", so every edit behaves the same. */
function useSaveMutation<TInput>(
  run: (input: TInput) => Promise<unknown>,
  options: {
    toast: string;
    close: () => void;
    failure: string;
    refresh: () => void;
    pushToast: ReturnType<typeof useToastActions>["pushToast"];
    setError: (message: string) => void;
  },
) {
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      options.refresh();
      options.close();
      options.pushToast({ title: options.toast, tone: "success" });
    },
    onError: (error) => options.setError(errorText(error, options.failure)),
  });
}

export function ContractPage() {
  const { contractId } = useParams<{ contractId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canUse = useCanUseContracts(selectedCompanyId);
  const companyId = selectedCompanyId ?? "";
  const id = contractId ?? "";
  const enabled = Boolean(selectedCompanyId && contractId) && canUse;

  const [factsOpen, setFactsOpen] = useState(false);
  const [termDialog, setTermDialog] = useState<{ term: ContractTerm | null } | null>(null);
  const [deadlineDialog, setDeadlineDialog] = useState<{ deadline: ContractDeadline | null } | null>(null);
  const [partyOpen, setPartyOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const contractQuery = useQuery({
    queryKey: queryKeys.contracts.detail(companyId, id),
    queryFn: () => contractsApi.get(companyId, id),
    enabled,
  });
  const contract = contractQuery.data;

  const versionsQuery = useQuery({
    queryKey: queryKeys.contracts.versions(companyId, id),
    queryFn: () => contractsApi.versions(companyId, id),
    enabled,
  });
  const listQuery = useQuery({
    queryKey: queryKeys.contracts.list(companyId),
    queryFn: () => contractsApi.list(companyId),
    enabled,
  });
  const organisationsQuery = useQuery({
    queryKey: queryKeys.contracts.organisations(companyId),
    queryFn: () => contractsApi.listOrganisations(companyId),
    enabled,
    retry: false,
  });
  const organisations = organisationsQuery.data ?? [];
  const organisationNames = new Map(organisations.map((org) => [org.id, org.name]));

  useEffect(() => {
    setBreadcrumbs([{ label: "Legal", href: "/legal" }, { label: contract?.title ?? "Contract" }]);
  }, [setBreadcrumbs, contract?.title]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all(companyId) });

  const useSave = <TInput,>(
    run: (input: TInput) => Promise<unknown>,
    done: { toast: string; close: () => void },
    failure: string,
  ) =>
    useSaveMutation(run, {
      ...done,
      failure,
      refresh,
      pushToast,
      setError: setDialogError,
    });

  const saveFacts = useSave(
    (draft: Parameters<typeof factsUpdate>[1]) => contractsApi.update(companyId, id, factsUpdate(contract!, draft)),
    { toast: "Contract details saved", close: () => setFactsOpen(false) },
    "The details could not be saved.",
  );
  const saveTerm = useSave(
    (draft: Parameters<typeof termInputFromDraft>[0]) =>
      contractsApi.setTerm(companyId, id, termKeyFromDraft(draft), termInputFromDraft(draft)),
    { toast: "Key term saved", close: () => setTermDialog(null) },
    "The key term could not be saved.",
  );
  const saveDeadline = useSave(
    (draft: Parameters<typeof deadlineInputFromDraft>[0]) =>
      deadlineDialog?.deadline
        ? contractsApi.updateDeadline(companyId, id, deadlineDialog.deadline.id, deadlineInputFromDraft(draft))
        : contractsApi.addDeadline(companyId, id, deadlineInputFromDraft(draft)),
    { toast: "Date saved", close: () => setDeadlineDialog(null) },
    "The date could not be saved.",
  );
  const addParty = useSave(
    (draft: { role: string; organizationId: string; name: string }) =>
      contractsApi.addParty(companyId, id, {
        role: draft.role.trim(),
        organizationId: draft.organizationId || null,
        name: draft.organizationId ? null : draft.name.trim(),
      }),
    { toast: "Added to the contract", close: () => setPartyOpen(false) },
    "They could not be added.",
  );
  const linkVersion = useSave(
    (draft: { previousContractId: string; changeSummary: string; carryDeadlines: boolean }) =>
      contractsApi.linkPreviousVersion(companyId, id, {
        previousContractId: draft.previousContractId,
        changeSummary: draft.changeSummary.trim(),
        carryDeadlines: draft.carryDeadlines,
      }),
    { toast: "Versions linked", close: () => setLinkOpen(false) },
    "The versions could not be linked.",
  );

  const quick = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => refresh(),
    onError: (error) => pushToast({ title: "That did not work", body: errorText(error, ""), tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: () => contractsApi.remove(companyId, id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.contracts.detail(companyId, id) });
      refresh();
      pushToast({ title: "Contract removed", tone: "success" });
      navigate("/legal");
    },
    onError: (error) => {
      setDeleteOpen(false);
      pushToast({ title: "The contract could not be removed", body: errorText(error, ""), tone: "error" });
    },
  });

  function openDialog(open: () => void) {
    setDialogError(null);
    open();
  }

  if (!canUse) {
    return (
      <div className="mx-auto max-w-3xl py-10">
        <EmptyState icon={FileText} message="Legal is only open to people who can make changes in this company." />
      </div>
    );
  }
  if (contractQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (contractQuery.error || !contract) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 py-6">
        <Link to="/legal" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All contracts
        </Link>
        <p className="text-sm text-destructive" role="alert">
          {errorText(contractQuery.error, "This contract could not be found.")}
        </p>
      </div>
    );
  }

  const live = isContractLive(contract.status);
  const versions = versionsQuery.data ?? [];
  const olderCandidates = (listQuery.data ?? []).filter(
    (item) => item.id !== contract.id && item.status !== "superseded",
  );
  const openDeadlines = contract.deadlines.filter((deadline) => deadline.state === "open");
  const takenKeys = contract.terms.map((term) => term.key);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="space-y-3">
        <Link to="/legal" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All contracts
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <h1 className="text-lg font-semibold">{contract.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{CONTRACT_TYPE_LABELS[contract.type]}</Badge>
              <Badge variant="outline">{CONTRACT_STATUS_LABELS[contract.status]}</Badge>
              {contract.versionNo > 1 ? <Badge variant="outline">Version {contract.versionNo}</Badge> : null}
              {contract.textStatus === "no_text_layer" ? (
                <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
                  <FileWarning />
                  Scanned, no readable text
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => openDialog(() => setFactsOpen(true))}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Change details
            </Button>
            <Button variant="outline" onClick={() => setDeleteOpen(true)} aria-label="Remove this contract">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {contract.status === "superseded" ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            A newer version has replaced this contract. It stays here as a record.
          </p>
        ) : null}
      </div>

      <Section title="The file" testId="contract-file">
        <div className="space-y-2 rounded-lg border border-border p-4">
          {contract.assetId ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={contractsApi.fileUrl(contract.assetId)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open the file
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={contractsApi.fileUrl(contract.assetId)} download>
                  Download
                </a>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No file is attached to this contract yet.</p>
          )}
          <div>
            <p className="text-sm font-medium" data-testid="contract-text-status">
              {CONTRACT_TEXT_STATUS_LABELS[contract.textStatus]}
            </p>
            <p className="text-sm text-muted-foreground">{CONTRACT_TEXT_STATUS_HELP[contract.textStatus]}</p>
          </div>
        </div>
      </Section>

      <Section title="Summary" testId="contract-summary">
        <div className="space-y-4 rounded-lg border border-border p-4">
          <p className="whitespace-pre-wrap text-sm">
            {contract.summary?.trim() ? contract.summary : "No summary yet. Use Change details to write one."}
          </p>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Starts" value={formatDay(contract.effectiveDate)} />
            <Fact label="Ends" value={formatDay(contract.expiryDate)} />
            <Fact label="Renews on its own" value={renewalText(contract)} />
            <Fact
              label="Notice period"
              value={contract.noticePeriodDays === null ? "Not known" : `${contract.noticePeriodDays} days`}
            />
            <Fact label="Which country's law applies" value={contract.governingLaw?.trim() || "Not known"} />
            <Fact label="Language" value={contract.language?.trim() || "Not known"} />
          </dl>
        </div>
      </Section>

      <Section
        title="Who is on this contract"
        testId="contract-parties"
        action={
          <Button variant="outline" size="sm" onClick={() => openDialog(() => setPartyOpen(true))}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add someone
          </Button>
        }
      >
        {contract.parties.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one has been added yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {contract.parties.map((party) => (
              <li key={party.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span>
                  <span className="font-medium">{partyDisplayName(party, organisationNames)}</span>
                  <span className="text-muted-foreground"> · {party.role}</span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${partyDisplayName(party, organisationNames)}`}
                  onClick={() => quick.mutate(() => contractsApi.removeParty(companyId, id, party.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Key terms"
        testId="contract-terms"
        action={
          <Button variant="outline" size="sm" onClick={() => openDialog(() => setTermDialog({ term: null }))}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add a term
          </Button>
        }
      >
        {contract.terms.length === 0 ? (
          <p className="text-sm text-muted-foreground">No key terms have been recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Term</th>
                  <th className="px-4 py-2 font-medium">What the contract says</th>
                  <th className="px-4 py-2 font-medium">Where</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {contract.terms.map((term) => (
                  <tr key={term.id} data-testid="contract-term-row">
                    <td className="px-4 py-2 font-medium">{termLabel(term.key)}</td>
                    <td className="px-4 py-2">{formatTermValue(term)}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {[term.clauseRef ? `Clause ${term.clauseRef}` : null, term.pageRef ? `page ${term.pageRef}` : null]
                        .filter(Boolean)
                        .join(", ") || "Not given"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Change ${termLabel(term.key)}`}
                        onClick={() => openDialog(() => setTermDialog({ term }))}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${termLabel(term.key)}`}
                        onClick={() => quick.mutate(() => contractsApi.removeTerm(companyId, id, term.key))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Dates that matter"
        testId="contract-deadlines"
        action={
          live ? (
            <Button variant="outline" size="sm" onClick={() => openDialog(() => setDeadlineDialog({ deadline: null }))}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add a date
            </Button>
          ) : null
        }
      >
        {contract.deadlines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dates have been recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {contract.deadlines.map((deadline) => {
              const open = deadline.state === "open";
              const soon = open && daysUntil(deadline.dueDate) <= DEADLINE_SOON_DAYS;
              return (
                <li key={deadline.id} className="space-y-1 px-4 py-3" data-testid="contract-deadline-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{DEADLINE_KIND_LABELS[deadline.kind]}</span>
                      <span className={soon ? "text-sm font-medium text-destructive" : "text-sm"}>{deadlineWhen(deadline)}</span>
                      <Badge variant={open ? "secondary" : "outline"}>{DEADLINE_STATE_LABELS[deadline.state]}</Badge>
                    </div>
                    {deadline.state !== "superseded" ? (
                      <div className="flex items-center gap-1">
                        {open ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                quick.mutate(() => contractsApi.updateDeadline(companyId, id, deadline.id, { state: "done" }))
                              }
                            >
                              Mark as done
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                quick.mutate(() => contractsApi.updateDeadline(companyId, id, deadline.id, { state: "dismissed" }))
                              }
                            >
                              Set aside
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              quick.mutate(() => contractsApi.updateDeadline(companyId, id, deadline.id, { state: "open" }))
                            }
                          >
                            Open again
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Change ${DEADLINE_KIND_LABELS[deadline.kind]}`}
                          onClick={() => openDialog(() => setDeadlineDialog({ deadline }))}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${DEADLINE_KIND_LABELS[deadline.kind]}`}
                          onClick={() => quick.mutate(() => contractsApi.removeDeadline(companyId, id, deadline.id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[
                      deadline.clauseRef ? `Clause ${deadline.clauseRef}` : null,
                      describeRemindDays(deadline.leadTimesDays),
                      deadline.note?.trim() || null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {deadline.reminders && deadline.reminders.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Reminders sent:{" "}
                      {deadline.reminders.map((reminder, index) =>
                        reminder.issueId ? (
                          <span key={`${reminder.leadDays}-${index}`}>
                            {index > 0 ? ", " : ""}
                            <Link to={`/issues/${reminder.issueId}`} className="underline">
                              {reminder.leadDays} days before
                            </Link>
                          </span>
                        ) : (
                          <span key={`${reminder.leadDays}-${index}`}>
                            {index > 0 ? ", " : ""}
                            {reminder.leadDays} days before
                          </span>
                        ),
                      )}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {live && openDeadlines.length === 0 && contract.deadlines.length > 0 ? (
          <p className="text-xs text-muted-foreground">No open dates are left on this contract.</p>
        ) : null}
      </Section>

      <Section
        title="Versions"
        testId="contract-versions"
        action={
          contract.supersedesContractId === null && olderCandidates.length > 0 && contract.status !== "superseded" ? (
            <Button variant="outline" size="sm" onClick={() => openDialog(() => setLinkOpen(true))}>
              This replaces an older version
            </Button>
          ) : null
        }
      >
        {versions.length <= 1 ? (
          <p className="text-sm text-muted-foreground">This is the only version on file.</p>
        ) : (
          <ol className="divide-y divide-border rounded-lg border border-border">
            {[...versions].reverse().map((version) => (
              <li key={version.id} className="px-4 py-3 text-sm" data-testid="contract-version-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {version.versionNo}</span>
                  {version.id === contract.id ? (
                    <Badge variant="secondary">You are here</Badge>
                  ) : (
                    <Link to={`/legal/${version.id}`} className="text-primary underline-offset-4 hover:underline">
                      {version.title}
                    </Link>
                  )}
                  <Badge variant="outline">{CONTRACT_STATUS_LABELS[version.status]}</Badge>
                  {version.effectiveDate ? (
                    <span className="text-xs text-muted-foreground">From {formatDay(version.effectiveDate)}</span>
                  ) : null}
                </div>
                {version.changeSummary ? (
                  <p className="mt-1 text-muted-foreground">What changed: {version.changeSummary}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <ContractFactsDialog
        open={factsOpen}
        onOpenChange={setFactsOpen}
        contract={contract}
        busy={saveFacts.isPending}
        errorMessage={dialogError}
        onSave={(draft) => {
          setDialogError(null);
          saveFacts.mutate(draft);
        }}
      />
      <TermDialog
        open={termDialog !== null}
        onOpenChange={(open) => !open && setTermDialog(null)}
        term={termDialog?.term ?? null}
        takenKeys={takenKeys}
        busy={saveTerm.isPending}
        errorMessage={dialogError}
        onSave={(draft) => {
          setDialogError(null);
          saveTerm.mutate(draft);
        }}
      />
      <DeadlineDialog
        open={deadlineDialog !== null}
        onOpenChange={(open) => !open && setDeadlineDialog(null)}
        deadline={deadlineDialog?.deadline ?? null}
        busy={saveDeadline.isPending}
        errorMessage={dialogError}
        onSave={(draft) => {
          setDialogError(null);
          saveDeadline.mutate(draft);
        }}
      />
      <PartyDialog
        open={partyOpen}
        onOpenChange={setPartyOpen}
        organisations={organisations}
        busy={addParty.isPending}
        errorMessage={dialogError}
        onSave={(draft) => {
          setDialogError(null);
          addParty.mutate(draft);
        }}
      />
      <LinkVersionDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        candidates={olderCandidates}
        busy={linkVersion.isPending}
        errorMessage={dialogError}
        onSave={(draft) => {
          setDialogError(null);
          linkVersion.mutate(draft);
        }}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this contract?</AlertDialogTitle>
            <AlertDialogDescription>
              "{contract.title}" and its dates and key terms are removed from Legal. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
