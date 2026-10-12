import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PUBLIC_WEB_PAGE_OUTBOUND_POLICY, createSafeOutboundFetch, type OutboundFetch } from "./safe-outbound-fetch.js";
import { isSecretBearingPath, maskFileForScreen, redactForScreen } from "./brag-secret-mask.js";

/**
 * DUR-4520: where a brag video's raw material comes from. Website mode goes
 * ONLY through createSafeOutboundFetch(PUBLIC_WEB_PAGE_OUTBOUND_POLICY) --
 * https, public addresses, same-host redirects only, size/time caps. No
 * ad-hoc fetcher. Code mode reads the project's own workspace checkout and
 * pushes every file through the secret mask before the text can reach a
 * scene. Everything returned here is already redacted.
 */

export interface BragSourceMaterial {
  kind: "website" | "code";
  title: string;
  /** Redacted text snippets, one per candidate scene, most prominent first. */
  snippets: string[];
  /** Paths/URLs that were skipped for being secret-bearing (names only, never content). */
  skipped: string[];
}

const MAX_SNIPPETS = 15;
const MAX_SNIPPET_CHARS = 280;
const MAX_FILES_READ = 40;
const MAX_FILE_BYTES = 128 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", ".venv", "venv", "__pycache__"]);
const TEXT_EXT_RE = /\.(md|mdx|txt|ts|tsx|js|jsx|py|go|rs|json|ya?ml|html|css)$/i;
const README_RE = /^readme(\.\w+)?$/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS - 1)}…` : flat;
}

export function extractPageMaterial(html: string): { title: string; snippets: string[] } {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(stripped)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const snippets: string[] = [];
  const blockRe = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(stripped)) && snippets.length < MAX_SNIPPETS) {
    const text = clip(decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")));
    if (text.length >= 12) snippets.push(redactForScreen(text));
  }
  return { title: redactForScreen(title), snippets };
}

export async function fetchWebsiteMaterial(url: string, fetchImpl?: OutboundFetch): Promise<BragSourceMaterial> {
  const safeFetch = fetchImpl ?? createSafeOutboundFetch(PUBLIC_WEB_PAGE_OUTBOUND_POLICY);
  const response = await safeFetch(url, { method: "GET", headers: { accept: "text/html" } });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The page answered with status ${response.status}.`);
  }
  const { title, snippets } = extractPageMaterial(await response.text());
  return { kind: "website", title: title || new URL(url).hostname, snippets, skipped: [] };
}

async function* walk(root: string, dir: string, budget: { left: number }): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (budget.left <= 0) return;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow links out of the checkout
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(root, full, budget);
    } else if (entry.isFile()) {
      budget.left -= 1;
      yield relative(root, full);
    }
  }
}

export async function readWorkspaceMaterial(root: string, projectName: string): Promise<BragSourceMaterial> {
  const skipped: string[] = [];
  const candidates: string[] = [];
  for await (const rel of walk(root, root, { left: 5000 })) {
    if (isSecretBearingPath(rel)) {
      skipped.push(rel);
      continue;
    }
    if (TEXT_EXT_RE.test(rel)) candidates.push(rel);
  }
  // READMEs and docs first -- they carry the story; source files only fill the gaps.
  candidates.sort((a, b) => Number(README_RE.test(b.split("/").pop()!)) - Number(README_RE.test(a.split("/").pop()!)) || a.length - b.length);
  const snippets: string[] = [];
  let filesRead = 0;
  for (const rel of candidates) {
    if (filesRead >= MAX_FILES_READ || snippets.length >= MAX_SNIPPETS) break;
    const full = join(root, rel);
    const st = await lstat(full).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue;
    filesRead += 1;
    const masked = maskFileForScreen(rel, await readFile(full, "utf8").catch(() => ""));
    if (masked.skipped || !masked.content) continue;
    const firstParagraph = masked.content
      .split(/\n{2,}/)
      .map((p) => clip(p.replace(/^[#>*\-\s]+/gm, "")))
      .find((p) => p.length >= 20);
    if (firstParagraph) snippets.push(firstParagraph);
  }
  return { kind: "code", title: redactForScreen(projectName), snippets, skipped };
}
