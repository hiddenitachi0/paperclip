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

## Decision: one paperless-ngx container per company

Decided by Filip (1 Oct 2026): **one paperless-ngx instance per company**,
not a shared instance with tag-based isolation. A company that has never
turned documents on has no container, volume, or backup target for it at
all — the instance is created only when a company switches the feature on,
and torn down (volume kept, container stopped) if the company switches it
back off. Document data must never cross between companies; with a separate
container, volume and backup target per company that boundary is physical,
not just an application-level filter.

Each company's `data_connections` row of kind `paperless_ngx` stores that
company's own `config.baseUrl` (its container's internal address) and its
own API token credential — there is no shared instance and no cross-company
tag to get wrong. Provisioning a new company's container/volume is a host
step (see "Host steps for Filip" below); our server only ever talks to the
one `baseUrl` recorded on that company's connection row, through the same
kind of host-allowlist `safe-outbound-fetch.ts` already enforces for
Fiken/WooCommerce, so even a bug in our query-building code cannot reach
another company's container — the network path to it doesn't exist from
that company's connection config.

Every instance runs on an encrypted volume, on the host, never publicly
reachable (bound to localhost / an internal network only, one port per
company container).

## Shape: a new data-connections kind, `paperless_ngx`

This fits the existing per-company external-service pattern in
`server/src/services/data-sources/` (`registry.ts`, `connection-kind.ts`,
`contract.ts`) almost exactly, even though today that framework is used for
sales/finance adapters:

- A `data_connections` row of kind `paperless_ngx`, storing `config: {
  baseUrl }` (non-secret, this company's own container address) and a
  credential (that container's API token) through the same
  encrypted-credential path Fiken's connections already use — nothing new to
  build for secret storage.
- `outboundPolicy`: a single allowed host, the configured `baseUrl` (same
  shape as `FIKEN_OUTBOUND_POLICY`) — scoped to this one company's container,
  so the policy itself cannot be pointed at another company's instance.
- A new dataset kind, `"documents"` (today's `DataDataset` union is
  `sales | finance`; this adds a kind, not a new column).
- `check()` ("Test" button): confirms the token works against this company's
  container and that the API is reachable.
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
  never talks to paperless-ngx directly, only to our server, which resolves
  the call against the requesting company's own `data_connections` row and
  thus its own container's `baseUrl`; there is no shared store for a bug to
  leak across).

Both refuse with a plain sentence when the company hasn't switched documents
on, same wording style as `assertEnabled` above.

## Audit & cost

Every read goes through the same `data_read_events` audit row shape the
Shopify/Fiken adapters already write (`DataLookupAudit`): request count,
duration, refusal code. paperless-ngx has no per-request cost unit like
Shopify's query cost, so `costPoints` is always 0 for this kind; a request
budget still applies (max N searches per quick-agent turn) to bound how much
one conversation can hammer that company's own container.

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
  another company's documents, full stop — each company has its own
  container, so there is no shared store to leak across in the first place.

## Security

Touches secrets (API token), permissions (per-company isolation) and privacy
(document contents can be sensitive) — **Security Reviewer 2 sign-off is
required before merge** of the Phase 1 implementation PR, specifically on:
that a company's `paperless_ngx` connection can only ever be configured to
point at that company's own container (no admin path lets one company's
`baseUrl`/credential be swapped for another's), that the outbound-fetch
allowlist is scoped per connection rather than a single fork-wide allowlist,
and that the proxied download path always resolves the container from the
requesting company's own connection row rather than any cached or
cross-request value.

## Host steps for Filip

- Per company that switches documents on: provision one paperless-ngx
  container, one volume, and one backup target for that company, on an
  encrypted volume, bound to an internal/localhost-only address (never
  publicly exposed), with its own port/internal address and its own admin
  API token.
- A company that has never turned documents on gets no container, volume, or
  backup target — nothing is pre-provisioned speculatively.
- Add that company's container URL + API token to Paperclip's own secret
  store as that company's `paperless_ngx` connection credential (same
  mechanism as any other data-connection credential).
- This doc assumes Filip (or a host script Filip runs) provisions
  containers manually per company for Phase 1; a fully automated
  provision-on-toggle flow (our server calling out to create the container)
  is out of scope here and would itself need its own security review before
  the server is given that kind of host control.

## Questions for Filip

1. Is Phase 2 (uploading/scanning documents in, e.g. via Telegram) wanted at
   all, or is this permanently a read/search/cite-only integration over
   documents someone files by hand on the host?
2. Any existing paperless-ngx instance already running we should point a
   first company at, or is Phase 1's host step a fresh install per company?
3. For provisioning: is a manual host script (Filip runs it per company when
   a company enables documents) acceptable for Phase 1, or is automated
   container provisioning from our server itself needed on day one?

## Phases

- **Phase 0 (this doc).**
- **Phase 1**: `paperless_ngx` data-source kind (read-only), feature flag,
  `search_documents`/`get_document` agent tools, Security Reviewer 2 review.
  Small PR, no new DB table beyond the standard `data_connections` row and
  `plugin_company_settings` key — both existing tables.
- **Phase 2 (separate task, if wanted)**: upload/consume path.
