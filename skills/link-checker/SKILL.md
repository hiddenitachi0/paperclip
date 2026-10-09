---
name: link-checker
description: Crawl a website and report broken internal and external links, using the server link-checker service.
---

# Link checker

`server/src/services/link-checker-service.ts` exports `checkLinks(startUrl, options)`.

- Crawls same-origin pages from `startUrl` up to `maxDepth` (default 2) and `maxPages` (default 100).
- Checks external links by HTTP status when `checkExternal` is true (default).
- URLs are normalized (fragment dropped, host lower-cased); `mailto:`, `tel:`, `javascript:` and `#` links are skipped.
- Returns `{ startUrl, pagesCrawled, linksChecked, broken[], truncated }`; each broken entry has `url`, `status` (null if unreachable), `internal`, and `sourcePages`.
- Requests use the safe outbound fetch: public https hosts only, no internal addresses, no cross-host redirects (a refused redirect counts as a working link). Plain-http links are reported as broken with the refusal reason.
