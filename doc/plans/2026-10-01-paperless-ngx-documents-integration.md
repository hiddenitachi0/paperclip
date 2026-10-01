# Documents: paperless-ngx as an optional per-company service (DUR-4152)

Design-first per the task's ground rules. No code in this PR; a small follow-up
PR implements Phase 1 once this is reviewed.

## Goal

Let a company optionally turn on document scanning/OCR/tagging/search backed
by a self-hosted [paperless-ngx](https://docs.paperless-ngx.com/) instance, so
agents can find and cite documents (contracts, letters, forms) in answers.
Off by default, per-company. Accounting receipts stay in Fiken — this is for
everything else.

paperless-ngx is GPL-3. Per the inspiration rule, we integrate with its
**public REST API only** (no code, prompts, or text copied from its
repository) and write our own client, schema and UI from scratch.

## What paperless-ngx's API gives us

paperless-ngx exposes a token-authenticated REST API (`Authorization: Token
<key>`), documented via its own OpenAPI schema at `/api/schema/`. The
research report's 403 was the hosted docs *site*, not the API itself — the
schema is served by the application and is the authoritative reference; we
read it from our own test instance before writing the client, rather than
trusting any cached description of it.

Endpoints we plan to use:
- `GET /api/documents/?query=...` — full-text search over OCR'd content
  (title, correspondent, tags, content snippet, score).
- `GET /api/documents/{id}/` — metadata for one document.
- `GET /api/documents/{id}/download/` and `/preview/` — binary content.
- `GET /api/correspondents/`, `/api/tags/`, `/api/document_types/` — the
  facets we expose as search filters.
- `POST /api/documents/post_document/` — upload (Phase 2, see below).

## Decision: one shared instance, tag-isolated per company

paperless-ngx is a single-tenant app (one user base, one document store); it
has no concept of "company" the way Paperclip does. Two options:

1. **One paperless-ngx container per company.** Clean isolation, but an
   operational cost that scales with company count (one more service, volume,
   backup target, and upgrade to carry per company).
2. **One shared paperless-ngx instance**, with every document tagged by an
   auto-created correspondent or tag named for the company
   (`paperclip-company-<id>`), and Paperclip's own server enforcing that a
   company's agents only ever see documents carrying its tag — paperless-ngx
   itself is never reachable directly by an agent or the browser.

This doc assumes **option 2** (shared instance) as the default, because nginx
places real OS/DB load per instance and we expect many companies to each have
a handful of documents, not an archive. The isolation guarantee is entirely
on our side: every read our server makes against paperless-ngx is scoped by
an injected `tags__id` (or `correspondent`) filter the caller cannot override,
the same shape the existing `data_connections` framework already uses to keep
one company's Shopify/Fiken reads from ever seeing another's rows. If Filip
would rather pay the operational cost for instance-per-company isolation,
that only changes `describeTarget`/the connection's `config.baseUrl` — the
agent tool surface and credential handling below are unaffected either way.
**Flagged as a question for Filip below.**

The instance itself runs on an encrypted volume, on the host, never
publicly reachable (bound to localhost / an internal network only); the only
caller is our server's outbound fetch, through the same kind of host-allowlist
`safe-outbound-fetch.ts` already enforces for Fiken/WooCommerce.

## Shape: a new data-connections kind, `paperless_ngx`

This fits the existing per-company external-service pattern in
`server/src/services/data-sources/` (`registry.ts`, `connection-kind.ts`,
`contract.ts`) almost exactly, even though today that framework is used for
sales/finance adapters:

- A `data_connections` row of kind `paperless_ngx`, storing `config: {
  baseUrl, companyTag }` (non-secret) and a credential (the API token) through
  the same encrypted-credential path Fiken's connections already use —
  nothing new to build for secret storage.
- `outboundPolicy`: a single allowed host, the configured `baseUrl` (same
  shape as `FIKEN_OUTBOUND_POLICY`).
- A new dataset kind, `"documents"` (today's `DataDataset` union is
  `sales | finance`; this adds a kind, not a new column).
- `check()` ("Test" button): confirms the token works and that the expected
  tag/correspondent for this company exists (creating it on first activation
  if missing).
- No `SalesAdapter` — this kind's `adapters` bucket gets a new shape,
  `documents?: (context) => DocumentsAdapter`, with `search(query, filters)`
  and `get(documentId)`, mirroring how `sales` is optional per kind today.

Feature flag: a `plugin_company_settings` row (new plugin key, e.g.
`DOCUMENTS_PLUGIN_KEY`), `settingsJson.documentsEnabled` — identical
"no row or missing key means off" pattern DUR-4127 used for video
storylines (`server/src/services/video-storyline-settings.ts`). The
connection itself can exist (so an admin can configure and Test it) while
reads stay refused until the flag is explicitly turned on, same as every
other new-behavior-ships-off rule in this fork.

## Agent-facing tool surface (Phase 1, read-only)

Two tools, modeled on the existing data-source quick-agent tools:

- `search_documents(query, tags?)` → up to ~10 results, each `{ id, title,
  correspondent, date, tags, snippet }`. The snippet is the OCR excerpt
  paperless-ngx's own search already returns around the match — we do not
  re-run OCR or re-rank.
- `get_document(id)` → full metadata plus a short-lived, server-proxied
  download link (never the raw paperless-ngx URL or token — the browser/agent
  never talks to paperless-ngx directly, only to our server, which checks the
  company tag on every single document read before proxying bytes or text).

Both refuse with a plain sentence when the company hasn't switched documents
on, same wording style as `assertEnabled` above.

## Audit & cost

Every read goes through the same `data_read_events` audit row shape the
Shopify/Fiken adapters already write (`DataLookupAudit`): request count,
duration, refusal code. paperless-ngx has no per-request cost unit like
Shopify's query cost, so `costPoints` is always 0 for this kind; a request
budget still applies (max N searches per quick-agent turn) to bound how much
one conversation can hammer the shared instance.

## Explicitly out of scope for Phase 1

- **Upload/consume** (`post_document/`): writing documents in is Phase 2.
  Phase 1 is search-and-cite over documents a person already filed through
  paperless-ngx's own (admin-only, not operator-facing) UI directly on the
  host. Phase 2 would add a "scan to Paperclip" path (e.g. a Telegram photo →
  our server → paperless-ngx's consume folder/API) — per the ground rule that
  a feature is only done when the whole path works, that becomes its own
  task with its own bridge-side test coverage, not bundled here.
- **Accounting receipts**: explicitly stay in Fiken; this integration should
  never be offered as a receipts/bookkeeping path.
- **Cross-company sharing**: never. One company's agents can never see
  another's tag, full stop, even on the shared-instance option.

## Security

Touches secrets (API token), permissions (per-company read isolation) and
privacy (document contents can be sensitive) — **Security Reviewer 2 sign-off
is required before merge** of the Phase 1 implementation PR, specifically on:
the tag-isolation enforcement (can a crafted `tags__id` or search query ever
cross a company boundary?), and that the proxied download path checks the
tag on every call rather than caching an authorization decision.

## Host steps for Filip

- Stand up one paperless-ngx container (shared instance, per the default
  above) on an encrypted volume, bound to an internal/localhost-only address
  — never publicly exposed.
- Generate one admin API token for Paperclip's server to use when creating
  per-company tags and tokens is not supported by a single shared admin
  token's scope (paperless-ngx has no per-tag API-token scoping; our server
  enforces the boundary, not paperless-ngx itself — see Security above).
- Add the instance's internal URL + that token to Paperclip's own secret
  store (same mechanism as any other data-connection credential).

## Questions for Filip

1. Shared instance with our own tag-based isolation (default assumed above),
   or one paperless-ngx container per company? The latter is stronger
   isolation but a real new piece of infra per company.
2. Is Phase 2 (uploading/scanning documents in, e.g. via Telegram) wanted at
   all, or is this permanently a read/search/cite-only integration over
   documents someone files by hand on the host?
3. Any existing paperless-ngx instance already running we should point at,
   or is Phase 1's host step a fresh install?

## Phases

- **Phase 0 (this doc).**
- **Phase 1**: `paperless_ngx` data-source kind (read-only), feature flag,
  `search_documents`/`get_document` agent tools, Security Reviewer 2 review.
  Small PR, no new DB table beyond the standard `data_connections` row and
  `plugin_company_settings` key — both existing tables.
- **Phase 2 (separate task, if wanted)**: upload/consume path.
