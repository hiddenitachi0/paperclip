# syntax=docker/dockerfile:1.20
#
# Paperclip render worker: a locked-down container that turns Hyperframes
# HTML compositions (code-drawn infographics, explainers, Brag videos) into
# MP4. Paperclip's server sends it a composition over an internal-only
# network and fetches the finished file back; see ./README.md.
#
# Build context is THIS directory (docker/render-worker), not the repo root:
# the worker is a standalone npm package with its own package-lock.json, so it
# never touches the monorepo's pnpm-lock.yaml.
#
#   docker build -t paperclip-render-worker:local docker/render-worker
#
# Base pinned by digest, not tag: `node:22.23.4-bookworm-slim` resolved
# (2026-10-27) to this manifest-list digest (amd64 + arm64). Bump it
# deliberately: re-resolve the tag and update this comment.
#
# amd64 only in practice: chrome-headless-shell (the browser Hyperframes uses
# for its deterministic BeginFrame capture) has no Linux arm64 build.
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base

# ffmpeg encodes; the libraries are what chrome-headless-shell links
# against; the fonts are the only fonts a composition can use (the container
# has no route to Google Fonts or any other CDN).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    fontconfig \
    fonts-dejavu-core \
    fonts-inter \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-core \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f

# Hyperframes' own switches, for the build steps below and as a fallback at
# run time (the worker passes them to every child explicitly anyway).
ENV HYPERFRAMES_NO_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_NO_AUTO_INSTALL=1 \
    HYPERFRAMES_SKIP_SKILLS=1 \
    CI=1

WORKDIR /opt/render-worker

# Exact versions from package-lock.json; no install scripts run (sharp and
# esbuild ship their Linux binaries as plain optional packages).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

# The browser Hyperframes pins for this version (chrome-headless-shell
# 152.0.7977.30 for hyperframes 0.8.150), downloaded once at build time into
# the image -- never at run time, where there is no network.
RUN HOME=/opt/render-worker/browser-home ./node_modules/.bin/hyperframes browser ensure \
  && ln -s "$(HOME=/opt/render-worker/browser-home ./node_modules/.bin/hyperframes browser path | tail -n 1)" /usr/local/bin/chrome-headless-shell \
  && /usr/local/bin/chrome-headless-shell --version

# Optional GSAP (off by default). GSAP's "standard no-charge" licence is not
# an open-source licence, so it is only added when the operator chooses it:
#   docker build --build-arg WITH_GSAP=1 ...
# The worker then serves jsDelivr GSAP addresses from this local copy.
ARG WITH_GSAP=0
ARG GSAP_VERSION=3.15.0
RUN if [ "$WITH_GSAP" = "1" ]; then \
      mkdir -p /tmp/gsap && cd /tmp/gsap \
      && npm pack "gsap@${GSAP_VERSION}" --silent \
      && tar -xzf "gsap-${GSAP_VERSION}.tgz" \
      && mkdir -p /opt/render-worker/vendor/gsap \
      && cp package/dist/*.min.js /opt/render-worker/vendor/gsap/ \
      && cp package/README.md /opt/render-worker/vendor/gsap/README.md \
      && rm -rf /tmp/gsap; \
    fi

COPY src ./src
COPY licenses ./licenses
COPY THIRD_PARTY_NOTICES.md README.md ./

# Non-root with a fixed uid. The compose overlay runs it as
# 10001:<server's gid> so the server (in that group) can open the socket,
# which the worker makes owner+group only (0660).
RUN groupadd --system --gid 10001 render \
  && useradd --system --uid 10001 --gid 10001 --home-dir /work --shell /usr/sbin/nologin render \
  && mkdir -p /work/jobs \
  && chown -R 10001:10001 /work

ENV NODE_ENV=production \
    HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell \
    RENDER_WORKER_JOBS_DIR=/work/jobs

USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "src/healthcheck.mjs"]
CMD ["node", "src/server.mjs"]
