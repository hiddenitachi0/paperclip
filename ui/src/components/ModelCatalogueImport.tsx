import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  MODEL_DIRECTORY_EXPORT_VERSION,
  type ModelDirectoryCatalogueEntry,
  type ModelDirectoryCatalogueImportResult,
} from "@paperclipai/shared";
import { Loader2, Upload } from "lucide-react";
import { modelDirectoryApi } from "../api/modelDirectory";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { importPreview, parseCatalogueFile } from "../lib/model-catalogue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * "Import" on Settings > Models: pick a models file (made with Export, here or
 * in another company), see how many are new and how many are already here,
 * choose what happens to the ones already here, then import and see what
 * was added, updated or skipped and why.
 */

type Picked =
  | { fileName: string; error: string }
  | { fileName: string; entries: ModelDirectoryCatalogueEntry[] };

/** Text of a picked file (FileReader where Blob.text is missing). */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsText(file);
  });
}

function namesList(names: readonly string[], max = 8): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

function importErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only the company owner or an admin can import models.";
    return error.message;
  }
  return "Could not import the models. Please try again.";
}

export function ModelCatalogueImport({
  companyId,
  existing,
  onImported,
}: {
  companyId: string;
  /** Every saved model here (archived ones too), to say which names already exist. */
  existing: ReadonlyArray<{ name: string }>;
  onImported: () => void;
}) {
  const { pushToast } = useToastActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [onExisting, setOnExisting] = useState<"skip" | "update">("skip");
  const [result, setResult] = useState<ModelDirectoryCatalogueImportResult | null>(null);

  const importMutation = useMutation({
    mutationFn: (entries: ModelDirectoryCatalogueEntry[]) =>
      modelDirectoryApi.importCatalogue(companyId, {
        version: MODEL_DIRECTORY_EXPORT_VERSION,
        entries,
        onExisting,
      }),
    onSuccess: (done) => {
      setResult(done);
      onImported();
      pushToast({
        title: `Import finished: ${done.created.length} added, ${done.updated.length} updated, ${done.skipped.length} skipped`,
        tone: done.skipped.length > 0 ? "warn" : "success",
      });
    },
    onError: (error) => pushToast({ title: importErrorMessage(error), tone: "error" }),
  });

  const close = () => {
    setPicked(null);
    setResult(null);
    setOnExisting("skip");
    importMutation.reset();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setPicked({ fileName: file.name, error: "Could not read this file. Pick it again." });
      return;
    }
    const parsed = parseCatalogueFile(text);
    setPicked(parsed.ok ? { fileName: file.name, entries: parsed.entries } : { fileName: file.name, error: parsed.error });
  };

  const entries = picked && "entries" in picked ? picked.entries : null;
  const preview = entries ? importPreview(entries, existing) : null;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} data-testid="models-import">
        <Upload className="mr-1.5 h-3.5 w-3.5" /> Import
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        data-testid="models-import-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Clear it so picking the same file again still fires.
          event.target.value = "";
          void onFile(file);
        }}
      />

      <Dialog open={picked !== null} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" data-testid="models-import-dialog">
          <DialogHeader>
            <DialogTitle>Import models</DialogTitle>
            <DialogDescription>{picked?.fileName}</DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-2 text-sm" data-testid="models-import-result">
              <p>
                Added {result.created.length} · Updated {result.updated.length} · Skipped {result.skipped.length}
              </p>
              {result.created.length > 0 && (
                <p className="text-xs text-muted-foreground">Added: {namesList(result.created)}</p>
              )}
              {result.updated.length > 0 && (
                <p className="text-xs text-muted-foreground">Updated: {namesList(result.updated)}</p>
              )}
              {result.skipped.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {result.skipped.map((skip) => (
                    <li key={skip.name}>
                      Skipped {skip.name}: {skip.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : picked && "error" in picked ? (
            <p className="text-sm text-destructive" data-testid="models-import-error">
              {picked.error}
            </p>
          ) : preview ? (
            <div className="space-y-3 text-sm" data-testid="models-import-preview">
              <p>
                {entries!.length} {entries!.length === 1 ? "model" : "models"} in this file: {preview.fresh.length} new,{" "}
                {preview.existing.length} already here.
              </p>
              {preview.existing.length > 0 && (
                <fieldset className="space-y-1.5">
                  <legend className="text-xs text-muted-foreground">
                    Already here: {namesList(preview.existing)}. If a model with the same name exists:
                  </legend>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="models-import-existing"
                      value="skip"
                      checked={onExisting === "skip"}
                      onChange={() => setOnExisting("skip")}
                      data-testid="models-import-skip"
                    />
                    Skip it (keep what is here)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="models-import-existing"
                      value="update"
                      checked={onExisting === "update"}
                      onChange={() => setOnExisting("update")}
                      data-testid="models-import-update"
                    />
                    Update it with the version in the file
                  </label>
                </fieldset>
              )}
              <p className="text-xs text-muted-foreground">No keys are in the file; agents keep theirs.</p>
            </div>
          ) : null}

          <DialogFooter>
            {result || (picked && "error" in picked) ? (
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={close} disabled={importMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  disabled={!entries || importMutation.isPending}
                  onClick={() => entries && importMutation.mutate(entries)}
                  data-testid="models-import-confirm"
                >
                  {importMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Import {entries?.length ?? ""} {entries?.length === 1 ? "model" : "models"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
