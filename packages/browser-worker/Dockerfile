# syntax=docker/dockerfile:1.20
#
# DUR-4065: image for packages/browser-worker -- the sandboxed browser
# container and its egress proxy in docker/docker-compose.browser.yml. Built
# the same way as the server image (build context is the repo root; see
# `build:` in that overlay), because this package imports
# @paperclipai/adapter-utils as a pnpm workspace package.
#
# Base pinned by digest, not tag: `mcr.microsoft.com/playwright:v1.58.2-noble`
# resolved (2026-09-29) to this manifest-list digest, which covers both
# amd64 and arm64. A moved tag or a compromised registry cannot silently
# change what ships here; bump the digest deliberately (re-resolve the tag,
# update the comment date) when moving to a new Playwright version, matching
# the `playwright-core` version pinned in package.json.
FROM mcr.microsoft.com/playwright@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/browser-worker/package.json packages/browser-worker/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY packages/plugins/media-studio/package.json packages/plugins/media-studio/
COPY packages/plugins/mission-control/package.json packages/plugins/mission-control/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/
# --frozen-lockfile needs every workspace package.json present (the lockfile
# is monorepo-wide), but --filter only installs what browser-worker actually
# needs to run: itself, @paperclipai/adapter-utils (source-only, no runtime
# deps of its own), express and playwright-core.
RUN pnpm install --frozen-lockfile --filter @paperclipai/browser-worker...

FROM base AS production
WORKDIR /app
COPY --from=deps /app /app
COPY . .

ENV TSX_DISABLE_CACHE=1

# Both container entrypoints the overlay uses. `browser` runs the default
# (no `command:`/`entrypoint:` override in the overlay); `browser-egress`
# sets `entrypoint: ["egress-proxy"]`, which replaces the image ENTRYPOINT
# outright, so `egress-proxy` must resolve on PATH as its own executable,
# not as an argument to a wrapper.
COPY --chmod=0755 <<'WORKER_EOF' /usr/local/bin/worker
#!/bin/sh
set -e
exec node --import /app/packages/browser-worker/node_modules/tsx/dist/loader.mjs /app/packages/browser-worker/src/entrypoints/worker.ts
WORKER_EOF
COPY --chmod=0755 <<'EGRESS_EOF' /usr/local/bin/egress-proxy
#!/bin/sh
set -e
exec node --import /app/packages/browser-worker/node_modules/tsx/dist/loader.mjs /app/packages/browser-worker/src/entrypoints/egress-proxy.ts
EGRESS_EOF

# The overlay sets `user: pwuser` (the base image's built-in non-root user)
# and `read_only: true` at the container level; nothing here needs to run as
# root, so no USER directive -- the runtime `user:` override is enough and
# keeps this image's own default (root) usable for one-off debugging.
ENTRYPOINT ["worker"]
