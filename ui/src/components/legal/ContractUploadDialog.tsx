import { useEffect, useMemo, useState } from "react";
import { CONTRACT_TYPES, type ContractStatus, type ContractType } from "@paperclipai/shared";
import {
  CONTRACT_FILE_MAX_BYTES,
  CONTRACT_FILE_UPLOAD_READY,
  type Contract,
} from "../../api/contracts";
import { CONTRACT_TYPE_LABELS } from "../../lib/contract-labels";
import { suggestPreviousVersion } from "../../lib/contract-version-suggestion";
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

/**
 * Add a contract. Pick the file (PDF or Word), say what kind it is, and, if it
 * looks like a newer copy of one already on file, say which. The guess only
 * fills the box in: the person can change it or say "No", and nothing is
 * linked until they press the button.
 */

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const ACCEPTED_FILE_NAMES = /\.(pdf|docx)$/i;
export const NOT_A_NEW_VERSION = "";

export interface ContractUploadValues {
  title: string;
  type: ContractType;
  status: ContractStatus;
  file: File | null;
  previousContractId: string;
  changeSummary: string;
  carryDeadlines: boolean;
}

export function fileProblem(file: File): string | null {
  if (!ACCEPTED_FILE_NAMES.test(file.name)) return "Choose a PDF or a Word (.docx) file.";
  if (file.size > CONTRACT_FILE_MAX_BYTES) return "That file is too big. The limit is 25 MB.";
  return null;
}

function titleFromFileName(name: string): string {
  return name.replace(ACCEPTED_FILE_NAMES, "").replace(/[_]+/g, " ").trim();
}

export function ContractUploadDialog({
  open,
  onOpenChange,
  existing,
  busy,
  errorMessage,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: Contract[];
  busy: boolean;
  errorMessage?: string | null;
  onSubmit: (values: ContractUploadValues) => void;
}) {
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [type, setType] = useState<ContractType>("other");
  const [status, setStatus] = useState<ContractStatus>("active");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [previousContractId, setPreviousContractId] = useState(NOT_A_NEW_VERSION);
  const [previousTouched, setPreviousTouched] = useState(false);
  const [changeSummary, setChangeSummary] = useState("");
  const [carryDeadlines, setCarryDeadlines] = useState(true);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setTitleTouched(false);
    setType("other");
    setStatus("active");
    setFile(null);
    setFileError(null);
    setPreviousContractId(NOT_A_NEW_VERSION);
    setPreviousTouched(false);
    setChangeSummary("");
    setCarryDeadlines(true);
  }, [open]);

  const candidates = useMemo(() => existing.filter((contract) => contract.status !== "superseded"), [existing]);
  const suggestion = useMemo(() => suggestPreviousVersion(title, type, candidates), [title, type, candidates]);

  // The guess follows the title until the person picks something themselves.
  useEffect(() => {
    if (!previousTouched) setPreviousContractId(suggestion?.id ?? NOT_A_NEW_VERSION);
  }, [suggestion, previousTouched]);

  const linking = previousContractId !== NOT_A_NEW_VERSION;
  const canSave = title.trim().length > 0 && (!linking || changeSummary.trim().length > 0) && !fileError && !busy;

  function pickFile(next: File | null) {
    setFile(next);
    setFileError(next ? fileProblem(next) : null);
    if (next && !titleTouched) setTitle(titleFromFileName(next.name));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a contract</DialogTitle>
          <DialogDescription>
            The contract stays private to the people who can open Legal. Nothing is sent anywhere.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {CONTRACT_FILE_UPLOAD_READY ? (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="contract-file">
                The contract file (PDF or Word)
              </label>
              <Input
                id="contract-file"
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
                disabled={busy}
              />
              {fileError ? <p className="text-xs text-destructive">{fileError}</p> : null}
            </div>
          ) : (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              data-testid="contract-file-not-ready"
            >
              Adding the contract file is not switched on yet. You can add the contract's details now and attach the
              file later.
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="contract-title">
              What do you call it?
            </label>
            <Input
              id="contract-title"
              value={title}
              placeholder="For example: Office lease, Oslo"
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleTouched(true);
              }}
              disabled={busy}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="contract-type">
                What kind is it?
              </label>
              <select
                id="contract-type"
                className={selectClass}
                value={type}
                onChange={(event) => setType(event.target.value as ContractType)}
                disabled={busy}
              >
                {CONTRACT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {CONTRACT_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="contract-status">
                Is it in force?
              </label>
              <select
                id="contract-status"
                className={selectClass}
                value={status}
                onChange={(event) => setStatus(event.target.value as ContractStatus)}
                disabled={busy}
              >
                <option value="active">Yes, it is active</option>
                <option value="draft">Not yet, still a draft</option>
              </select>
            </div>
          </div>

          {candidates.length > 0 ? (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="contract-previous">
                Is this a newer version of a contract you already have?
              </label>
              <select
                id="contract-previous"
                className={selectClass}
                value={previousContractId}
                onChange={(event) => {
                  setPreviousTouched(true);
                  setPreviousContractId(event.target.value);
                }}
                disabled={busy}
              >
                <option value={NOT_A_NEW_VERSION}>No, this is a separate contract</option>
                {candidates.map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    Yes, it replaces: {contract.title}
                  </option>
                ))}
              </select>
              {suggestion && !previousTouched ? (
                <p className="text-xs text-muted-foreground">
                  This looks like a newer copy of "{suggestion.title}". Change it if that is wrong.
                </p>
              ) : null}
            </div>
          ) : null}

          {linking ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="contract-change-summary">
                  What changed from the older version?
                </label>
                <Textarea
                  id="contract-change-summary"
                  value={changeSummary}
                  rows={3}
                  placeholder="For example: rent goes up 3%, notice period is now 6 months"
                  onChange={(event) => setChangeSummary(event.target.value)}
                  disabled={busy}
                />
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={carryDeadlines}
                  onChange={(event) => setCarryDeadlines(event.target.checked)}
                  disabled={busy}
                />
                <span>Keep the older version's open dates on this new version</span>
              </label>
            </div>
          ) : null}

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                type,
                status,
                file,
                previousContractId,
                changeSummary: changeSummary.trim(),
                carryDeadlines,
              })
            }
          >
            {busy ? "Saving…" : "Add contract"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
