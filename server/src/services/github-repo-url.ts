/** `https://github.com/<owner>/<name>(.git)` -> `{ owner, name }`; anything else is null. */
export function parseGitHubRepoFromUrl(repoUrl: string | null | undefined): { owner: string; name: string } | null {
  if (!repoUrl) return null;
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.host.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const [owner, rawName] = parsed.pathname.replace(/^\/+/, "").split("/");
    if (!owner || !rawName) return null;
    return { owner, name: rawName.replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}
