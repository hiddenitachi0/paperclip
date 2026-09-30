# Web data engine (Crawl4AI), competitor watch, product grabber

DUR-4151. Three pieces, split into three PRs/child issues because each is
independently useful, independently risky, and would otherwise make one PR
too large to review well.

## 1. Crawl4AI internal worker (infra)

Follow the exact pattern already shipped for the browser worker
(`docker/docker-compose.browser.yml`, DUR-4015/DUR-4065/DUR-4013):

- New overlay `docker/docker-compose.crawl4ai.yml`, layered the same way:
  `-f docker/docker-compose.yml -f docker/docker-compose.prod.yml -f docker/docker-compose.browser.yml -f docker/docker-compose.crawl4ai.yml`.
- `crawl4ai` service on `browser-internal` (`internal: true`) ONLY — no
  published port, ever. Its outbound route is `browser-egress`, the same
  proxy the Maja browser worker already uses
  (`packages/browser-worker/src/egress-proxy.ts`) — do not stand up a second
  egress path.
- Pin the image to Crawl4AI **0.9.4 or later** (CVE-2026-26216 affects
  everything before 0.8.0) — pin by digest, not just tag, same as
  `browser-worker-image` does today.
- Downloads off, no agent-written hooks (Crawl4AI's `hook` extension point
  lets caller code run inside the crawl — never expose that to any agent or
  any request body; the server-side client is the only caller and it must
  never forward user/agent text into a hook field).
- Hardening to mirror `browser` in the existing overlay: non-root user,
  `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs for
  writable paths, `mem_limit`/`cpus`/`pids_limit` caps.
- Server talks to it over an internal-only HTTP client
  (`server/src/services/crawl4ai-client.ts`, new) the same shape as
  `browser-worker-client.ts` — bearer token from `PAPERCLIP_SERVER_` prefixed
  env (keeps it out of agent envs per `server-env-secrets.ts`), never a
  public network path.
- Apache-2.0 credit line kept (README/NOTICE or an in-repo `THIRD_PARTY.md`
  entry — check what the repo already does for other Apache-2.0
  dependencies and match it).
- PR ships infra + a "Host steps for Filip" section (env vars to set, image
  build/pull, firewall/compose file list to add) — Filip approves the actual
  deploy separately, per the ground rules. No deploy card filed by this PR.
- Needs Security Reviewer 2 sign-off before merge (new internal service,
  egress-adjacent, secrets).

## 2. Competitor watch — new "web page" Watchers source

Today `watchers` are symbol-based (`WATCHER_SOURCES = ["crypto", "us_stock",
"oslo_stock"]`, `packages/shared/src/watchers.ts`), one symbol per watcher,
priced by `watcher-sources.ts`, ruled by `watcher-rules.ts`. A web-page
watcher tracks a **URL**, not a symbol, so this needs real schema/type work,
not just a new source enum value:

- New source `"web_page"` in `WATCHER_SOURCES` / `WATCHER_SOURCE_INFO`
  (`packages/shared/src/watchers.ts`).
- New watch kinds: price, stock (in stock / out of stock), new products
  (on a listing page), text change (on any page) — each needs its own rule
  shape; do not force all four into the price-delta rule that
  `watcher-rules.ts` has today.
- Fetch path: page HTML through the Crawl4AI worker (item 1) — reuse it
  instead of standing up a second scraper. If Crawl4AI infra is not deployed
  yet, land this behind a thin interface (`WatcherWebPageFetcher`) with a
  fake for tests, so this PR is not hard-blocked on Filip's host approval
  for item 1; wire the real client once it's live.
  the CSS/text-region selector chosen per watcher, plus enough of the raw
  page (or a content hash) to diff on the next check.
- Storage: new table (migration **0189**, check origin/custom first per the
  ground rules — the merged-second PR renumbers) for the last-seen snapshot
  per watcher (selector value, price, stock state, or content hash + a short
  diff summary), separate from `watcherPricePoints` since the shapes differ.
- Respect robots.txt for the target page before ever fetching it, and cap
  check frequency the same way `WATCHER_SOURCE_INFO.minCheckMinutes` already
  does per source (pick a sane floor, e.g. not more often than hourly, since
  this is not a market feed).
- Alerting reuses the existing tick/lease/compose pipeline in
  `server/src/services/watchers.ts` unchanged — only the source-specific
  fetch + rule evaluation is new.
- Company-scoped like every other watcher; no cross-company page lists.
- Needs Security Reviewer 2 sign-off (new egress-adjacent fetch path from
  server-triggered code, SSRF-shaped surface even via Crawl4AI).

## 3. Product grabber (first template: ellos.no)

- Fetches product data + images from a vendor site into a **staging list**;
  a person approves rows before anything is used; the grabber itself never
  writes to Shopify or any storefront directly (approval → publish is a
  separate, later step, out of scope here unless trivial).
- Template-based: `ellos.no` is the first template, but the extractor
  interface must be vendor-agnostic (a template describes selectors/JSON-LD
  parsing for one site; adding a second vendor later must not touch core
  code) — "general tool for any company/site," per the issue and the parent
  roadmap's answer (5).
- Fetch path: same Crawl4AI worker as item 2 (share the internal client).
- Respect robots.txt and the vendor's terms; rate-limit requests per host;
  log every source URL fetched (company-scoped log, for audit — "vendors
  have given permission to use their product images" is Filip's
  representation for ellos.no specifically; the tool itself must still
  default to robots.txt-respecting behavior for any other site an operator
  points it at).
- New staging table (next migration after item 2's) for grabbed rows:
  vendor, source URL, raw extracted fields, image URLs, status
  (pending/approved/rejected), approved-by, timestamps. Company-scoped.
- UI: an approval list (Frontend Engineer) — plain list of staged rows with
  approve/reject, no jargon, per the ground rules on operator-facing copy.
- Ships switched off by default (no company sees a "Product grabber" nav
  entry or auto-runs until an operator turns it on for that company), since
  this changes what operators can do.
- Needs Security Reviewer 2 sign-off (external site scraping + image
  ingestion + a write path, even if staging-only).

## Sequencing

Item 1 (infra) is a standalone PR that can merge/wait-for-deploy
independently. Items 2 and 3 build against a small fetch-interface
abstraction so they are not blocked on Filip's host approval of item 1 —
they can merge with a fake fetcher under test and get the real Crawl4AI
client wired in a follow-up once item 1 is deployed, or wait if that lands
first. Either order is fine; do not let 2/3 block on 1's deploy.

## Open questions for Filip

- Product grabber write destination: is "staging only, human approves, then
  a *separate* later step pushes to Shopify" the right scope for v1, or
  should the approved-row → Shopify push be in scope now too? Assumed
  staging-only for this round.
- Web-page watcher check floor: proposed "not more often than hourly" absent
  a stated need for faster competitor-price checks — flag if that's wrong
  for the intended use.
