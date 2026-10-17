---
name: link-checker
description: Find broken links on a public website (internal pages and outbound links) and report them as a plain list with the page each one sits on. Use when asked to check a site for broken or dead links before or after a launch.
---

# Link checker

`server/src/services/link-checker-service.ts` exports `checkLinks(startUrl, options)`.

- Crawls same-origin pages from `startUrl` up to `maxDepth` (default 2) and `maxPages` (default 100).
- Checks external links by HTTP status when `checkExternal` is true (default).
- URLs are normalized (fragment dropped, host lower-cased); `mailto:`, `tel:`, `javascript:` and `#` links are skipped.
- Returns `{ startUrl, pagesCrawled, linksChecked, broken[], truncated }`; each broken entry has `url`, `status` (null if unreachable), `internal`, and `sourcePages`.
- Requests use the safe outbound fetch: public https hosts only, no internal addresses, no cross-host redirects (a refused redirect counts as a working link). Plain-http links are reported as broken with the refusal reason.

## How an agent uses this today

There is no Paperclip API route or tool for this service yet, so a normal agent cannot call `checkLinks` directly.

- **Inside a checkout of this repository** (Paperclip developers only): run it from a small script with the repo's own TypeScript runner and print the JSON result.
- **Anywhere else:** crawl with the tools you have (a browser tool or `curl -sI` on each link), follow the same rules as the service: public https only, at most 2 levels deep and 100 pages, skip `mailto:`/`tel:`/`javascript:`/`#` links.

Report the result as a table: broken link, status (or "unreachable"), internal or external, and the page(s) it appears on. Do not fix links on a live site without approval; propose the fixes instead.
