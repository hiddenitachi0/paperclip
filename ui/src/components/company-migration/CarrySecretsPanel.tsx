import { useMemo } from "react";
import type { CompanyPortabilityManifest } from "@paperclipai/shared";
import { KeyRound } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  carryableSecretInputs,
  describeScopedSecretKey,
  envInputScopedKey,
  manifestNames,
  passphraseStrength,
} from "../../lib/company-migration";
import { SecretsTravelWarnings } from "./SecretsTravelWarnings";

export interface CarrySecretsState {
  selected: Set<string>;
  passphrase: string;
  confirm: string;
}

export const EMPTY_CARRY_SECRETS_STATE: CarrySecretsState = {
  selected: new Set(),
  passphrase: "",
  confirm: "",
};

/**
 * Why the export button must wait, or null when it may go ahead. With nothing
 * ticked there is nothing to seal, so the passphrase does not matter.
 */
export function carrySecretsBlocker(state: CarrySecretsState): string | null {
  if (state.selected.size === 0) return null;
  const strength = passphraseStrength(state.passphrase);
  if (!strength.acceptable) return strength.hint;
  if (state.passphrase !== state.confirm) return "The two passphrases are not the same.";
  return null;
}

const strengthTone: Record<string, string> = {
  empty: "text-muted-foreground",
  too_short: "text-destructive",
  weak: "text-amber-600 dark:text-amber-400",
  ok: "text-emerald-600 dark:text-emerald-400",
  strong: "text-emerald-600 dark:text-emerald-400",
};

/**
 * Export screen: "Carry these secrets". Shows the NAMES of the secret settings
 * in the package (never a value) and a passphrase with confirmation. Only the
 * company's owner or an admin sees the checklist; the server refuses everyone
 * else anyway (routes/companies.ts assertMayExportSecrets).
 */
export function CarrySecretsPanel({
  manifest,
  canCarry,
  state,
  onChange,
}: {
  manifest: Pick<CompanyPortabilityManifest, "envInputs" | "agents" | "projects">;
  canCarry: boolean;
  state: CarrySecretsState;
  onChange: (next: CarrySecretsState) => void;
}) {
  const inputs = useMemo(() => carryableSecretInputs(manifest), [manifest]);
  const names = useMemo(() => manifestNames(manifest), [manifest]);
  const strength = passphraseStrength(state.passphrase);
  const mismatch = state.confirm.length > 0 && state.confirm !== state.passphrase;

  if (inputs.length === 0) return null;

  function toggle(scopedKey: string) {
    const selected = new Set(state.selected);
    if (selected.has(scopedKey)) selected.delete(scopedKey);
    else selected.add(scopedKey);
    onChange({ ...state, selected });
  }

  function setAll(on: boolean) {
    onChange({ ...state, selected: on ? new Set(inputs.map(envInputScopedKey)) : new Set() });
  }

  return (
    <div className="mx-5 mt-3 rounded-md border border-border px-4 py-3" data-testid="carry-secrets-panel">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        Carry these secrets
      </div>
      {!canCarry ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="carry-secrets-not-allowed">
          This company has {inputs.length} secret setting{inputs.length === 1 ? "" : "s"}. Only the company's owner or an
          admin can send secrets with an export. Without them, the secrets are typed in again on the new Paperclip.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            Tick the secrets that should move with the company. Only their names are shown here. The values are sealed
            with your passphrase into a separate file next to the export.
          </p>
          <div className="mt-2 flex gap-3 text-xs">
            <button type="button" className="underline" onClick={() => setAll(true)}>
              Tick all
            </button>
            <button type="button" className="underline" onClick={() => setAll(false)}>
              Tick none
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {inputs.map((input) => {
              const scopedKey = envInputScopedKey(input);
              const label = describeScopedSecretKey(scopedKey, names);
              return (
                <li key={scopedKey}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={state.selected.has(scopedKey)}
                      onChange={() => toggle(scopedKey)}
                      data-testid={`carry-secret-${scopedKey}`}
                    />
                    <span className="font-mono text-xs">{label.key}</span>
                    <span className="text-xs text-muted-foreground">for {label.owner}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {state.selected.size > 0 && (
            <div className="mt-3 space-y-2">
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block text-xs">
                  <span className="text-muted-foreground">Passphrase</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    value={state.passphrase}
                    onChange={(e) => onChange({ ...state, passphrase: e.target.value })}
                    data-testid="carry-secrets-passphrase"
                  />
                </label>
                <label className="block text-xs">
                  <span className="text-muted-foreground">Type it again</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    value={state.confirm}
                    onChange={(e) => onChange({ ...state, confirm: e.target.value })}
                    data-testid="carry-secrets-passphrase-confirm"
                  />
                </label>
              </div>
              <p className={cn("text-xs", strengthTone[strength.level])} data-testid="carry-secrets-strength">
                {strength.hint}
              </p>
              {mismatch && (
                <p className="text-xs text-destructive" data-testid="carry-secrets-mismatch">
                  The two passphrases are not the same.
                </p>
              )}
              <SecretsTravelWarnings />
            </div>
          )}
        </>
      )}
    </div>
  );
}
