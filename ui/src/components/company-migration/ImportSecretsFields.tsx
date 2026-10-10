import { useRef, type ChangeEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SecretsTravelWarnings } from "./SecretsTravelWarnings";

export interface ImportSecretsState {
  file: { name: string; content: string } | null;
  passphrase: string;
}

export const EMPTY_IMPORT_SECRETS_STATE: ImportSecretsState = { file: null, passphrase: "" };

/** Why the import must wait, or null. A secrets file needs its passphrase. */
export function importSecretsBlocker(state: ImportSecretsState): string | null {
  if (!state.file) return null;
  if (state.passphrase.length === 0) return "Enter the passphrase for the secrets file.";
  return null;
}

/**
 * Import screen: the optional sealed secrets file from "Carry these secrets"
 * and its passphrase. The file is read in the browser and sent as-is; the
 * server opens it, so the secret values are never shown here.
 */
export function ImportSecretsFields({
  canBringSecrets,
  state,
  onChange,
  onReadError,
}: {
  canBringSecrets: boolean;
  state: ImportSecretsState;
  onChange: (next: ImportSecretsState) => void;
  onReadError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const content = (await file.text()).trim();
      if (!content) throw new Error("The secrets file is empty.");
      onChange({ ...state, file: { name: file.name, content } });
    } catch (err) {
      onReadError(err instanceof Error ? err.message : "Could not read the secrets file.");
    }
  }

  return (
    <div className="rounded-md border border-border px-3 py-3" data-testid="import-secrets-fields">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        Secrets from the old company (optional)
      </div>
      {!canBringSecrets ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="import-secrets-not-allowed">
          Only the company's owner or an admin can bring a secrets file in. Without it, secrets are typed in again on
          each agent or project after the import.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            If the export came with a <span className="font-mono">.secrets.enc</span> file, add it here with its
            passphrase. The values are opened on the server and saved as this company's secrets.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".enc,application/octet-stream,text/plain"
            className="hidden"
            onChange={handleFile}
            data-testid="import-secrets-file-input"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              Choose secrets file
            </Button>
            {state.file && (
              <>
                <span className="text-xs text-muted-foreground" data-testid="import-secrets-file-name">
                  {state.file.name}
                </span>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => onChange(EMPTY_IMPORT_SECRETS_STATE)}
                >
                  Remove
                </button>
              </>
            )}
          </div>
          {state.file && (
            <div className="mt-2 space-y-2">
              <label className="block text-xs">
                <span className="text-muted-foreground">Passphrase</span>
                <input
                  type="password"
                  autoComplete="off"
                  className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={state.passphrase}
                  onChange={(e) => onChange({ ...state, passphrase: e.target.value })}
                  data-testid="import-secrets-passphrase"
                />
              </label>
              <SecretsTravelWarnings />
            </div>
          )}
        </>
      )}
    </div>
  );
}
