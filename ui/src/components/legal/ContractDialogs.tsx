import { useEffect, useState, type ReactNode } from "react";
import {
  CONTRACT_DEADLINE_KINDS,
  CONTRACT_STATUSES,
  CONTRACT_TERM_VALUE_KINDS,
  CONTRACT_TYPES,
  type ContractTermValueKind,
} from "@paperclipai/shared";
import type {
  Contract,
  ContractDeadline,
  ContractDetail,
  ContractTerm,
  CrmOrganisationOption,
} from "../../api/contracts";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DEADLINE_KIND_LABELS,
  TERM_VALUE_KIND_LABELS,
} from "../../lib/contract-labels";
import {
  OTHER_TERM,
  WELL_KNOWN_TERM_CHOICES,
  deadlineDraftFromDeadline,
  deadlineProblem,
  emptyDeadlineDraft,
  emptyTermDraft,
  factsDraftFromContract,
  factsProblem,
  termDraftFromTerm,
  termProblem,
  type ContractFactsDraft,
  type DeadlineDraft,
  type TermDraft,
  type TriState,
} from "./contract-forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  saveLabel,
  busy,
  problem,
  errorMessage,
  onSave,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  saveLabel: string;
  busy: boolean;
  problem: string | null;
  errorMessage?: string | null;
  onSave: () => void;
  children: ReactNode;
}) {
  const [showProblem, setShowProblem] = useState(false);
  useEffect(() => {
    if (open) setShowProblem(false);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4">
          {children}
          {showProblem && problem ? <p className="text-sm text-destructive">{problem}</p> : null}
          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (problem) {
                setShowProblem(true);
                return;
              }
              onSave();
            }}
          >
            {busy ? "Saving…" : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the contract's own details

export function ContractFactsDialog({
  open,
  onOpenChange,
  contract,
  busy,
  errorMessage,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractDetail;
  busy: boolean;
  errorMessage?: string | null;
  onSave: (draft: ContractFactsDraft) => void;
}) {
  const [draft, setDraft] = useState<ContractFactsDraft>(() => factsDraftFromContract(contract));
  useEffect(() => {
    if (open) setDraft(factsDraftFromContract(contract));
    // Reset only when the dialog opens, so typing is never overwritten by a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof ContractFactsDraft>(key: K, value: ContractFactsDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  const replaced = contract.status === "superseded";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change contract details"
      description="Fix anything the assistant got wrong. Press Save to keep your changes."
      saveLabel="Save"
      busy={busy}
      problem={factsProblem(draft)}
      errorMessage={errorMessage}
      onSave={() => onSave(draft)}
    >
      <Field label="Name" htmlFor="facts-title">
        <Input id="facts-title" value={draft.title} onChange={(e) => set("title", e.target.value)} disabled={busy} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind" htmlFor="facts-type">
          <select
            id="facts-type"
            className={selectClass}
            value={draft.type}
            onChange={(e) => set("type", e.target.value as ContractFactsDraft["type"])}
            disabled={busy}
          >
            {CONTRACT_TYPES.map((value) => (
              <option key={value} value={value}>
                {CONTRACT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Status"
          htmlFor="facts-status"
          hint={replaced ? "A newer version has replaced this one, so its status cannot be changed." : undefined}
        >
          <select
            id="facts-status"
            className={selectClass}
            value={draft.status}
            onChange={(e) => set("status", e.target.value as ContractFactsDraft["status"])}
            disabled={busy || replaced}
          >
            {CONTRACT_STATUSES.filter((value) => value !== "superseded" || replaced).map((value) => (
              <option key={value} value={value}>
                {CONTRACT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" htmlFor="facts-effective">
          <Input
            id="facts-effective"
            type="date"
            value={draft.effectiveDate}
            onChange={(e) => set("effectiveDate", e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Ends" htmlFor="facts-expiry">
          <Input
            id="facts-expiry"
            type="date"
            value={draft.expiryDate}
            onChange={(e) => set("expiryDate", e.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Renews on its own?" htmlFor="facts-renew">
          <select
            id="facts-renew"
            className={selectClass}
            value={draft.autoRenewal}
            onChange={(e) => set("autoRenewal", e.target.value as TriState)}
            disabled={busy}
          >
            <option value="unknown">Not known</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        <Field label="Notice period (days)" htmlFor="facts-notice">
          <Input
            id="facts-notice"
            inputMode="numeric"
            value={draft.noticePeriodDays}
            onChange={(e) => set("noticePeriodDays", e.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Which country's law applies" htmlFor="facts-law">
          <Input id="facts-law" value={draft.governingLaw} onChange={(e) => set("governingLaw", e.target.value)} disabled={busy} />
        </Field>
        <Field label="Language of the contract" htmlFor="facts-language">
          <Input id="facts-language" value={draft.language} onChange={(e) => set("language", e.target.value)} disabled={busy} />
        </Field>
      </div>
      <Field label="Short summary" htmlFor="facts-summary">
        <Textarea id="facts-summary" rows={5} value={draft.summary} onChange={(e) => set("summary", e.target.value)} disabled={busy} />
      </Field>
    </FormDialog>
  );
}

// ---------------------------------------------------------------- key terms

export function TermDialog({
  open,
  onOpenChange,
  term,
  takenKeys,
  busy,
  errorMessage,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The term being changed, or null to add a new one. */
  term: ContractTerm | null;
  takenKeys: string[];
  busy: boolean;
  errorMessage?: string | null;
  onSave: (draft: TermDraft) => void;
}) {
  const [draft, setDraft] = useState<TermDraft>(emptyTermDraft);
  useEffect(() => {
    if (!open) return;
    if (term) {
      setDraft(termDraftFromTerm(term));
      return;
    }
    const firstFree = WELL_KNOWN_TERM_CHOICES.find((choice) => !takenKeys.includes(choice.key));
    setDraft({ ...emptyTermDraft(), choice: firstFree?.key ?? OTHER_TERM });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term]);
  const set = <K extends keyof TermDraft>(key: K, value: TermDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={term ? "Change a key term" : "Add a key term"}
      description="A fact the contract states, such as the notice period or when payment is due."
      saveLabel="Save"
      busy={busy}
      problem={termProblem(draft)}
      errorMessage={errorMessage}
      onSave={() => onSave(draft)}
    >
      <Field label="Which term is it?" htmlFor="term-choice">
        <select
          id="term-choice"
          className={selectClass}
          value={draft.choice}
          onChange={(e) => set("choice", e.target.value)}
          disabled={busy || term !== null}
        >
          {WELL_KNOWN_TERM_CHOICES.map((choice) => (
            <option key={choice.key} value={choice.key} disabled={!term && takenKeys.includes(choice.key)}>
              {choice.label}
              {!term && takenKeys.includes(choice.key) ? " (already added)" : ""}
            </option>
          ))}
          <option value={OTHER_TERM}>Something else…</option>
        </select>
      </Field>
      {draft.choice === OTHER_TERM ? (
        <Field label="Name of the term" htmlFor="term-name">
          <Input
            id="term-name"
            value={draft.customName}
            placeholder="For example: Cleaning fee"
            onChange={(e) => set("customName", e.target.value)}
            disabled={busy || term !== null}
          />
        </Field>
      ) : null}
      <Field label="What does the contract say?" htmlFor="term-kind">
        <select
          id="term-kind"
          className={selectClass}
          value={draft.valueKind}
          onChange={(e) => set("valueKind", e.target.value as ContractTermValueKind)}
          disabled={busy}
        >
          {CONTRACT_TERM_VALUE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {TERM_VALUE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>
      {draft.valueKind === "number" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Number" htmlFor="term-number">
            <Input id="term-number" inputMode="decimal" value={draft.number} onChange={(e) => set("number", e.target.value)} disabled={busy} />
          </Field>
          <Field label="Currency (if it is money)" htmlFor="term-currency" hint="Three letters, for example NOK.">
            <Input id="term-currency" maxLength={3} value={draft.currency} onChange={(e) => set("currency", e.target.value)} disabled={busy} />
          </Field>
        </div>
      ) : null}
      {draft.valueKind === "text" ? (
        <Field label="What it says" htmlFor="term-text">
          <Textarea id="term-text" rows={3} value={draft.text} onChange={(e) => set("text", e.target.value)} disabled={busy} />
        </Field>
      ) : null}
      {draft.valueKind === "bool" ? (
        <Field label="Answer" htmlFor="term-bool">
          <select
            id="term-bool"
            className={selectClass}
            value={draft.bool}
            onChange={(e) => set("bool", e.target.value as "yes" | "no")}
            disabled={busy}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Clause in the contract" htmlFor="term-clause">
          <Input id="term-clause" value={draft.clauseRef} placeholder="For example: 4.2" onChange={(e) => set("clauseRef", e.target.value)} disabled={busy} />
        </Field>
        <Field label="Page" htmlFor="term-page">
          <Input id="term-page" value={draft.pageRef} onChange={(e) => set("pageRef", e.target.value)} disabled={busy} />
        </Field>
      </div>
    </FormDialog>
  );
}

// ---------------------------------------------------------------- dates that matter

export function DeadlineDialog({
  open,
  onOpenChange,
  deadline,
  busy,
  errorMessage,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deadline: ContractDeadline | null;
  busy: boolean;
  errorMessage?: string | null;
  onSave: (draft: DeadlineDraft) => void;
}) {
  const [draft, setDraft] = useState<DeadlineDraft>(emptyDeadlineDraft);
  useEffect(() => {
    if (open) setDraft(deadline ? deadlineDraftFromDeadline(deadline) : emptyDeadlineDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deadline]);
  const set = <K extends keyof DeadlineDraft>(key: K, value: DeadlineDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={deadline ? "Change a date" : "Add a date"}
      description="A date when something has to happen, so you are reminded in good time."
      saveLabel="Save"
      busy={busy}
      problem={deadlineProblem(draft)}
      errorMessage={errorMessage}
      onSave={() => onSave(draft)}
    >
      <Field label="What happens on this date?" htmlFor="deadline-kind">
        <select
          id="deadline-kind"
          className={selectClass}
          value={draft.kind}
          onChange={(e) => set("kind", e.target.value as DeadlineDraft["kind"])}
          disabled={busy}
        >
          {CONTRACT_DEADLINE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {DEADLINE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" htmlFor="deadline-date">
          <Input id="deadline-date" type="date" value={draft.dueDate} onChange={(e) => set("dueDate", e.target.value)} disabled={busy} />
        </Field>
        <Field label="Clause in the contract" htmlFor="deadline-clause">
          <Input id="deadline-clause" value={draft.clauseRef} onChange={(e) => set("clauseRef", e.target.value)} disabled={busy} />
        </Field>
      </div>
      <Field
        label="Remind me this many days before"
        htmlFor="deadline-remind"
        hint="Separate the numbers with commas, for example 60, 30, 7. Leave empty to use the usual reminders."
      >
        <Input id="deadline-remind" value={draft.remindDays} onChange={(e) => set("remindDays", e.target.value)} disabled={busy} />
      </Field>
      <Field label="Note" htmlFor="deadline-note">
        <Textarea id="deadline-note" rows={3} value={draft.note} onChange={(e) => set("note", e.target.value)} disabled={busy} />
      </Field>
    </FormDialog>
  );
}

// ---------------------------------------------------------------- other party

export interface PartyDraft {
  role: string;
  organizationId: string;
  name: string;
}

export function partyProblem(draft: PartyDraft): string | null {
  if (!draft.role.trim()) return "Say what part they play, for example Landlord or Supplier.";
  if (!draft.organizationId && !draft.name.trim()) return "Pick a company from your contacts or write a name.";
  return null;
}

export function PartyDialog({
  open,
  onOpenChange,
  organisations,
  busy,
  errorMessage,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organisations: CrmOrganisationOption[];
  busy: boolean;
  errorMessage?: string | null;
  onSave: (draft: PartyDraft) => void;
}) {
  const [draft, setDraft] = useState<PartyDraft>({ role: "", organizationId: "", name: "" });
  useEffect(() => {
    if (open) setDraft({ role: "", organizationId: "", name: "" });
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add someone to this contract"
      saveLabel="Add"
      busy={busy}
      problem={partyProblem(draft)}
      errorMessage={errorMessage}
      onSave={() => onSave(draft)}
    >
      <Field label="Their part in the contract" htmlFor="party-role">
        <Input
          id="party-role"
          value={draft.role}
          placeholder="For example: Landlord, Supplier, Customer"
          onChange={(e) => setDraft((prev) => ({ ...prev, role: e.target.value }))}
          disabled={busy}
        />
      </Field>
      {organisations.length > 0 ? (
        <Field label="Company from your contacts" htmlFor="party-org">
          <select
            id="party-org"
            className={selectClass}
            value={draft.organizationId}
            onChange={(e) => setDraft((prev) => ({ ...prev, organizationId: e.target.value }))}
            disabled={busy}
          >
            <option value="">Not in my contacts</option>
            {organisations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {!draft.organizationId ? (
        <Field label="Name" htmlFor="party-name">
          <Input id="party-name" value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} disabled={busy} />
        </Field>
      ) : null}
    </FormDialog>
  );
}

// ---------------------------------------------------------------- older version

export interface LinkVersionDraft {
  previousContractId: string;
  changeSummary: string;
  carryDeadlines: boolean;
}

export function LinkVersionDialog({
  open,
  onOpenChange,
  candidates,
  busy,
  errorMessage,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: Contract[];
  busy: boolean;
  errorMessage?: string | null;
  onSave: (draft: LinkVersionDraft) => void;
}) {
  const [draft, setDraft] = useState<LinkVersionDraft>({ previousContractId: "", changeSummary: "", carryDeadlines: true });
  useEffect(() => {
    if (open) setDraft({ previousContractId: candidates[0]?.id ?? "", changeSummary: "", carryDeadlines: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const problem = !draft.previousContractId
    ? "Pick the older contract this one replaces."
    : !draft.changeSummary.trim()
      ? "Write what changed from the older version."
      : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="This replaces an older version"
      description="The older contract stays on file, marked as replaced, and this one becomes the current version."
      saveLabel="Link the versions"
      busy={busy}
      problem={problem}
      errorMessage={errorMessage}
      onSave={() => onSave(draft)}
    >
      <Field label="The older contract" htmlFor="link-previous">
        <select
          id="link-previous"
          className={selectClass}
          value={draft.previousContractId}
          onChange={(e) => setDraft((prev) => ({ ...prev, previousContractId: e.target.value }))}
          disabled={busy}
        >
          {candidates.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What changed from the older version?" htmlFor="link-summary">
        <Textarea
          id="link-summary"
          rows={3}
          value={draft.changeSummary}
          onChange={(e) => setDraft((prev) => ({ ...prev, changeSummary: e.target.value }))}
          disabled={busy}
        />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={draft.carryDeadlines}
          onChange={(e) => setDraft((prev) => ({ ...prev, carryDeadlines: e.target.checked }))}
          disabled={busy}
        />
        <span>Keep the older version's open dates on this version</span>
      </label>
    </FormDialog>
  );
}
