# Franchise phase C — signed update packets (plan only)

Status: plan, nothing built. Follows phase A (selective secrets, `portable-secret-bundle.ts`)
and phase B (export/import secrets UI, "Verify destination", "Mark as migrated").

## Problem

A migrated company runs on its own Paperclip (a client fork). When our `custom` branch
gets a fix or feature, the client fork needs it too, but:

- we must not push code into a client's server, and the client's server must not pull
  and run code by itself;
- the client (or their maintainer agent) must be able to see exactly what a change does
  and check that it really came from us before anything is applied.

An **update packet** is a self-contained, signed description of one change that a client
fork can verify offline and then apply through its own normal review path.

## Packet format

One directory or `.tar` file, named `<packet-id>.paperclip-update/`:

| File | What it is |
|---|---|
| `packet.json` | Manifest: `id` (e.g. `2026-11-03-claude-signin-retry`), `title`, `summary` (plain language, for the operator), `baseCommit` (the upstream commit the diff applies to), `targetCommit`, `createdAt`, `author`, `requires` (earlier packet ids), `touches` (`ui`/`server`/`db`/`cli`), `migrations` (file names, if any), `risk` (`low`/`medium`/`high`), and the SHA-256 of every other file in the packet. |
| `SPEC.md` | What the change does and why, in plain words first, then the technical contract (routes, columns, settings). Written so a maintainer agent can re-implement it if the diff does not apply. |
| `reference.diff` | `git diff baseCommit..targetCommit` limited to the files the change needs. A *reference*, not a patch to force: a fork that has drifted adapts it by following `SPEC.md`. |
| `acceptance/` | Acceptance tests that must pass after applying: vitest files plus a `run.json` listing the commands (`pnpm vitest run …`, typecheck per package). Each test names the behaviour it checks. |
| `packet.json.sig` | Detached Ed25519 signature over the exact bytes of `packet.json`. Because `packet.json` holds the hash of every other file, one signature covers the whole packet. |

Rules:

- No secrets and no customer data in a packet, ever. Packets are safe to email.
- Database changes are additive and guarded (`IF NOT EXISTS`), with a rollback note,
  same as our own migrations. Migration numbers are *not* fixed in the packet; the
  applier renumbers to the fork's next free number.
- A packet never contains built output (`dist/`), lockfile churn or dependency bumps
  unless `touches` says so and `risk` is at least `medium`.

## CLI: `paperclip update verify <packet>`

Read-only. It never applies anything.

1. Read `packet.json` and `packet.json.sig`; check the signature against the trusted
   keys (below). Unknown or revoked key → stop with a plain message.
2. Re-hash every file and compare with the manifest. Any mismatch → stop.
3. Check `requires`: which earlier packets this fork has already recorded as applied.
4. Dry-run `git apply --check reference.diff` against the fork's current checkout and
   report: applies cleanly / applies with fuzz / conflicts in these files.
5. Print a plain summary: title, summary, risk, what it touches, migrations it adds,
   whether it applies, and the exact next step ("ask your maintainer to apply this on a
   branch and run the acceptance tests").

Exit codes: `0` verified and applies, `2` verified but does not apply cleanly, `1`
not verified (signature, hash or key problem). `--json` for the maintainer agent.

Applying stays a normal code change on a branch in the client fork: the maintainer
(person or agent) applies `reference.diff` or re-implements from `SPEC.md`, runs
`acceptance/`, and merges through the fork's own review and deploy path. A later
`paperclip update record <packet>` may write the packet id to the fork's ledger after
merge; there is deliberately no `apply` command.

## Signing keys

- Ed25519, one **packet-signing key** per publisher (us). The private key lives
  offline / in a hardware token, never on a Paperclip server and never in an agent's
  reach (same rule as `trusted_code_fingerprints`: agents run as the server user).
- Each client fork pins trusted public keys in its repo (`update-keys/trusted.json`:
  key id, public key, valid-from, valid-until, comment). Changing that file is itself a
  reviewed commit in the fork, so an attacker who can send packets cannot add a key.
- Rotation: publish the new public key in a packet signed by the old key, plus
  out-of-band confirmation (phone/email) before the client merges it. Keep the old key
  valid for a grace period, then mark it expired.
- Revocation: `update-keys/revoked.json` lists key ids that must be refused even if
  still in `trusted.json`; `verify` checks it first.

## Order of work (when approved)

1. `packet.json` schema + hashing + Ed25519 verify in a small shared module, with tests
   (tampered file, wrong key, revoked key, missing `requires`).
2. `paperclip update verify` in the CLI, read-only, `--json` output.
3. A publisher script on our side that builds a packet from a merged PR
   (`baseCommit..targetCommit`, picks acceptance tests, signs with the offline key).
4. Maintainer-agent instructions in the client fork for applying a verified packet on a
   branch and running `acceptance/`.

## Out of scope

Auto-apply, auto-merge, pushing into client servers, any packet that carries secrets.
