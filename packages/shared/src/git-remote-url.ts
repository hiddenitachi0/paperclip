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

const SCP_LIKE_SYNTAX = /^[A-Za-z0-9._-]+@[^/]+:/;
const HAS_URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function hasEmbeddedGitCredential(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  // scp-like syntax, e.g. "git@github.com:owner/repo.git", has no field for
  // a password, and its single fixed account name carries no secret of its
  // own -- the real auth is the SSH key configured for that host.
  if (SCP_LIKE_SYNTAX.test(trimmed) && !HAS_URL_SCHEME.test(trimmed)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.password.length > 0) return true;
  if (parsed.username.length === 0) return false;
  // ssh's "user@host" is a fixed protocol convention (almost universally
  // "git"), not a secret in itself, so a bare username is exempt for ssh.
  // Every other scheme (https, http, git, ...) treats a bare username as
  // the credential (a GitHub PAT is passed exactly this way).
  return parsed.protocol !== "ssh:";
}

export function assertNoEmbeddedGitCredential(rawUrl: string): void {
  if (hasEmbeddedGitCredential(rawUrl)) {
    throw new Error(EMBEDDED_GIT_CREDENTIAL_ERROR_MESSAGE);
  }
}
