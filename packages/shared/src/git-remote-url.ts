// NOR-316: a fine-grained GitHub PAT embedded directly in a git remote URL
// (https://<token>@github.com/...) got copied into every git command's
// argv and error output, landing in 706 heartbeat_runs rows in cleartext.
// The safe alternatives -- a credential helper (GITHUB_TOKEN secret) or an
// SSH deploy key -- never require the secret to live in the URL itself, so
// any URL carrying its own username/password is rejected at the point a
// remote gets set rather than relying solely on after-the-fact scanning.
export const EMBEDDED_GIT_CREDENTIAL_ERROR_MESSAGE =
  "Remote URL must not contain embedded credentials (e.g. https://<token>@host/... or https://user:pass@host/...). " +
  "Use a credential helper (a GITHUB_TOKEN secret) or an SSH deploy key instead -- never put the secret in the URL.";

const SCP_LIKE_SYNTAX = /^([A-Za-z0-9._-]+)@([^/]+):/;
const HAS_URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// git/libcurl's own URL parser and WHATWG's `new URL()` disagree about what
// a backslash does inside the authority section of an http(s) URL: WHATWG
// treats it as a path/authority separator, libcurl treats it as a literal
// character. That lets a payload like
// "https://decoy.example\@user:pass@host/x.git" parse as credential-free
// under `new URL()` while git still authenticates with (and can leak) the
// hidden "user:pass". Don't try to out-parse libcurl -- just refuse any raw
// URL containing a literal backslash outright.
const HAS_BACKSLASH = /\\/;

export function hasEmbeddedGitCredential(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  if (HAS_BACKSLASH.test(trimmed)) return true;

  if (!HAS_URL_SCHEME.test(trimmed)) {
    // scp-like syntax, e.g. "git@github.com:owner/repo.git", has no field
    // for a password, and its one canonical account name ("git") carries no
    // secret of its own -- the real auth is the SSH key configured for that
    // host. Any other bare-string account name in this same position (e.g.
    // a PAT used as the scp "user"), or any string that merely resembles
    // this shape without matching it cleanly (e.g. "user:pass@host:path",
    // which doesn't parse as scp-like or as a scheme URL either), is
    // treated as carrying a credential rather than silently passed through.
    const scpMatch = trimmed.match(SCP_LIKE_SYNTAX);
    if (scpMatch) return scpMatch[1] !== "git";
    return trimmed.includes("@");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.password.length > 0) return true;
  if (parsed.username.length === 0) return false;
  // ssh's "user@host" is a fixed protocol convention -- almost universally
  // the literal account "git" -- not a secret in itself, so *only* that
  // canonical bare username is exempt for ssh. Every other scheme (https,
  // http, git, ...) treats a bare username as the credential (a GitHub PAT
  // is passed exactly this way), and so does any non-"git" ssh username.
  return !(parsed.protocol === "ssh:" && parsed.username === "git");
}

export function assertNoEmbeddedGitCredential(rawUrl: string): void {
  if (hasEmbeddedGitCredential(rawUrl)) {
    throw new Error(EMBEDDED_GIT_CREDENTIAL_ERROR_MESSAGE);
  }
}

const CREDENTIAL_IN_SCHEME_URL = /(:\/\/)[^\s@/]+@/g;
const CREDENTIAL_IN_SCP_LIKE = /(^|\s)([A-Za-z0-9._-]+)@([^\s@/]+):/g;

/**
 * Defense in depth for free text that may embed a git remote URL or echo
 * git's own stderr (e.g. a clone-failure message): git's error output is not
 * guaranteed credential-clean on every failure path, so any text that might
 * land in a persisted log should be scrubbed even when the upstream
 * `hasEmbeddedGitCredential` guard already passed.
 */
export function redactEmbeddedGitCredentials(text: string): string {
  return text
    .replace(CREDENTIAL_IN_SCHEME_URL, "$1<redacted>@")
    .replace(CREDENTIAL_IN_SCP_LIKE, (match, prefix: string, user: string, host: string) =>
      user === "git" ? match : `${prefix}<redacted>@${host}:`,
    );
}
