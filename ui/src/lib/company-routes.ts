/**
 * Every first path segment that names a PAGE rather than a company.
 *
 * This drives whether a link like "/personas" gets the company prefix added.
 * Anything not listed here is assumed to be a company prefix instead, so a page
 * missing from this set silently loses its prefix: the operator clicks Personas,
 * the URL stays "/personas", the app reads "PERSONAS" as the company, and the
 * page is broken. Personas, Changelog, Pipelines and Ask Paperclip were all
 * missing and all broken exactly that way.
 *
 * company-routes.test.ts asserts that every page the sidebar links to appears
 * here, so adding a page to the sidebar without adding it here fails the build
 * rather than shipping a dead link.
 */
const BOARD_ROUTE_ROOTS = new Set([
  "dashboard",
  "personas",
  "changelog",
  "pipelines",
  "simple",
  "learnings",
  "review-queue",
  "plugins",
  "companies",
  "company",
  "skills",
  "tools",
  "jobs",
  "teams-catalog",
  "org",
  "agents",
  "projects",
  "workspaces",
  "execution-workspaces",
  "issues",
  "routines",
  "goals",
  "files",
  "artifacts",
  "approvals",
  "costs",
  "goal-adoption",
  "usage",
  "activity",
  "inbox",
  "board-chat",
  "u",
  "design-guide",
  "search",
  "settings",
]);

const GLOBAL_ROUTE_ROOTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs", "instance"]);

export function normalizeCompanyPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function getRootSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

export function isGlobalPath(pathname: string): boolean {
  if (pathname === "/") return true;
  const root = getRootSegment(pathname);
  if (!root) return true;
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function isBoardPathWithoutPrefix(pathname: string): boolean {
  const root = getRootSegment(pathname);
  if (!root) return false;
  return BOARD_ROUTE_ROOTS.has(root.toLowerCase());
}

export function extractCompanyPrefixFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first)) {
    return null;
  }
  return normalizeCompanyPrefix(segments[0]!);
}

export function applyCompanyPrefix(path: string, companyPrefix: string | null | undefined): string {
  const { pathname, search, hash } = splitPath(path);
  if (!pathname.startsWith("/")) return path;
  if (isGlobalPath(pathname)) return path;
  if (!companyPrefix) return path;

  const prefix = normalizeCompanyPrefix(companyPrefix);
  const activePrefix = extractCompanyPrefixFromPath(pathname);
  if (activePrefix) return path;

  return `/${prefix}${pathname}${search}${hash}`;
}

export function toCompanyRelativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length >= 2) {
    const second = segments[1]!.toLowerCase();
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && BOARD_ROUTE_ROOTS.has(second)) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
