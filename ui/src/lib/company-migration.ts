import type { CompanyPortabilityEnvInput, CompanyPortabilityManifest } from "@paperclipai/shared";

/**
 * Franchise migration helpers shared by the export and import screens and the
 * "Moving this company" settings section. Pure, so they are tested directly.
 */

export const SECRETS_PASSPHRASE_MIN_LENGTH = 12;

export type PassphraseStrengthLevel = "empty" | "too_short" | "weak" | "ok" | "strong";

export interface PassphraseStrength {
  level: PassphraseStrengthLevel;
  /** One plain sentence shown under the field. */
  hint: string;
  /** True when the export may go ahead with this passphrase. */
  acceptable: boolean;
}

const COMMON_WEAK = ["password", "passord", "123456", "qwerty", "paperclip", "letmein", "abc123"];

/**
 * A rough strength hint, not a guarantee. Long passphrases of a few unrelated
 * words are encouraged; anything under 12 characters is refused because the
 * sealed file can be attacked offline by anyone who has a copy of it.
 */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  if (passphrase.length === 0) {
    return { level: "empty", hint: "Choose a passphrase of at least 12 characters.", acceptable: false };
  }
  if (passphrase.length < SECRETS_PASSPHRASE_MIN_LENGTH) {
    return {
      level: "too_short",
      hint: `Too short: use at least ${SECRETS_PASSPHRASE_MIN_LENGTH} characters. Four unrelated words work well.`,
      acceptable: false,
    };
  }
  const lower = passphrase.toLowerCase();
  const sameChar = /^(.)\1+$/.test(passphrase);
  const common = COMMON_WEAK.some((word) => lower.includes(word));
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(passphrase)).length;
  const words = passphrase.trim().split(/[\s\-_.]+/).filter((part) => part.length >= 3).length;
  if (sameChar || common || new Set(passphrase).size < 6) {
    return {
      level: "weak",
      hint: "Weak: this is easy to guess. Use a few unrelated words instead.",
      acceptable: true,
    };
  }
  if (passphrase.length >= 20 || words >= 4) {
    return { level: "strong", hint: "Strong.", acceptable: true };
  }
  if (passphrase.length >= 16 || classes >= 3) {
    return { level: "ok", hint: "Good. A little longer would be even better.", acceptable: true };
  }
  return {
    level: "weak",
    hint: "Weak: make it longer, or use a few unrelated words.",
    acceptable: true,
  };
}

/** The secret settings an export can carry, in the order the package lists them. */
export function carryableSecretInputs(manifest: Pick<CompanyPortabilityManifest, "envInputs">): CompanyPortabilityEnvInput[] {
  return (manifest.envInputs ?? []).filter((input) => input.kind === "secret");
}

export function envInputScopedKey(input: Pick<CompanyPortabilityEnvInput, "key" | "agentSlug" | "projectSlug">): string {
  if (input.agentSlug) return `agent:${input.agentSlug}:${input.key}`;
  if (input.projectSlug) return `project:${input.projectSlug}:${input.key}`;
  return input.key;
}

/**
 * "SHOP_TOKEN — agent Sales Assistant" for a scoped key, using the names in
 * the package when they are known. Names only; never a value.
 */
export function describeScopedSecretKey(
  scopedKey: string,
  names?: { agents?: Record<string, string>; projects?: Record<string, string> },
): { key: string; owner: string } {
  const parts = scopedKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    const slug = parts[1]!;
    return { key: parts.slice(2).join(":"), owner: `agent ${names?.agents?.[slug] ?? slug}` };
  }
  if (parts.length >= 3 && parts[0] === "project") {
    const slug = parts[1]!;
    return { key: parts.slice(2).join(":"), owner: `project ${names?.projects?.[slug] ?? slug}` };
  }
  return { key: scopedKey, owner: "the whole company" };
}

export function manifestNames(manifest: Pick<CompanyPortabilityManifest, "agents" | "projects"> | null | undefined) {
  return {
    agents: Object.fromEntries((manifest?.agents ?? []).map((agent) => [agent.slug, agent.name])),
    projects: Object.fromEntries((manifest?.projects ?? []).map((project) => [project.slug, project.name])),
  };
}

/** File name for the sealed secrets file that goes next to the package zip. */
export function secretsFileName(rootPath: string) {
  return `${rootPath || "company-package"}.secrets.enc`;
}

export function downloadTextFile(fileName: string, text: string) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The plain-English warnings shown wherever secrets travel. */
export const SECRETS_TRAVEL_WARNINGS = [
  "Anyone who has both the secrets file and the passphrase can read these secrets.",
  "The passphrase cannot be recovered. If it is lost, the secrets must be entered again by hand.",
  "Send the passphrase a different way than the file — for example, say it on the phone instead of putting it in the same email.",
] as const;
