# Paperclip render worker (code-drawn videos)

Charts, titles and explainers should be drawn by code, never by an image model. This folder is the locked-down
container that does it: it takes a [Hyperframes](https://github.com/heygen-com/hyperframes) HTML composition
(Apache-2.0, the renderer Brag uses) and turns it into an MP4 with a headless browser and ffmpeg. Paperclip's server
sends it jobs; agents never reach it directly.

- Plan card: "Code-rendered video worker for infographics and explainers" (Media Studio plan, Phase 4). Filip's
  decision D14 (27 Oct 2026): OK to add the container on the server.
- Not live until the **Security Reviewer gate** passes and the operator adds the container on the box (below). Until
  then Paperclip answers `503 "not set up"` on the code-render API and does nothing else.

## How it fits together

```
agent / person --HTTP--> Paperclip server --Unix socket (render-control volume)--> render worker
                          /api/companies/:id/code-renders                          Hyperframes + chrome-headless-shell + ffmpeg
                          (caps, budget gate, company files)                       (no network at all)
                          <-- MP4 / contact sheet saved into the company's Files --
```

1. An agent (skills `explainer-video`, `brag`) or a board member posts a composition to
   `POST /api/companies/{companyId}/code-renders` with `kind` `check`, `snapshot` or `render`.
2. The server checks the caps and the budget, reads any Media Studio files the job names **from that company only**,
   records a `code_render_jobs` row and forwards the job to the worker over the socket.
3. The worker writes the files into a fresh job folder, refuses anything that names an internet address, and runs
   `hyperframes check` / `snapshot` / `render`.
4. The server collects the result (when someone reads the job, or on the `codeRenders` scheduler tick), saves the MP4
   or contact sheet into the company's Files (or attaches it to the task), and tells the worker to delete its copy.

## Security model (what the Security Reviewer checks)

| Concern | How it is handled |
|---|---|
| Agent-written HTML in a browser | The container is the sandbox. Hyperframes starts Chrome with `--no-sandbox`, so the container gets no network (`network_mode: none`), no capabilities (`cap_drop: ALL`), `no-new-privileges`, Docker's default seccomp profile, a read-only root filesystem and a non-root user (uid 10001). |
| Network egress | None. No route to the internet, the cloud metadata address, the tailnet, the database, other containers or Paperclip's own API. The server reaches the worker over a Unix socket on a shared volume; the worker cannot open a connection anywhere. Compositions that name `http(s)://`, `ws(s)://`, `ftp://` or protocol-relative addresses are refused up front with a plain reason (`remote_urls`). |
| Other companies' files | The worker never fetches files. Paperclip reads each asset by (file id, company id) and sends the bytes inside the job, so a job can only carry its own company's files. Results are saved into the job's company. |
| Host access | No Docker socket, no host bind mounts. Two named volumes only: `render-control` (the socket) and `render-jobs` (per-job folders, emptied on every start, each job's folder deleted when it is collected, cancelled or failed, or after `RENDER_WORKER_RESULT_TTL_SECONDS`). |
| Paths | Composition paths are relative, plain ASCII, no `..`, no hidden files, allow-listed file types; files are written with `wx` (never overwriting or following a link). Nothing is ever unpacked from an archive. |
| Resource limits | Compose: 2 CPUs, 3 GB memory (no swap), 1 GB `/dev/shm`, 512 processes, 4096 open files, 512 MB `/tmp`. Worker: one job at a time, a queue of 8, a wall-clock limit per job kind (check 3 min, contact sheet 5 min, render 2 min + 8 s per second of video asked for at 30 fps, never above 30 min), a ceiling on video length (30 min) and on the output (2 GB), 300 MB per upload. A stopped job's whole process group is killed. |
| Zombie processes | `init: true` reaps the browser's orphaned helpers (the September container-zombie incident). |
| Secrets | The bearer token comes from `PAPERCLIP_SERVER_RENDER_WORKER_TOKEN` (the `PAPERCLIP_SERVER_` prefix keeps it out of agents' environments). The worker removes it from its own environment at start-up and starts every child (Hyperframes, Chrome, ffprobe) with an allow-listed environment, so no child can read it. Nothing secret is ever in a command line. |
| Budgets | Rendering costs no provider money; the caps count renderer minutes per agent and company per day (D7), jobs at once, and length per render. Every job counts: a finished render its video length, a check, a contact sheet and any failed or cancelled job the time the worker really spent on it (the worker's own start and finish times), and a job still in flight what it reserved. A render whose composition names a longer length than it asked for is refused before it runs. An agent that hits a cap is told to stop and ask a person. A paused or hard-stopped budget refuses every job. |
| Telemetry, updates | `HYPERFRAMES_NO_TELEMETRY`, `DO_NOT_TRACK`, `HYPERFRAMES_NO_UPDATE_CHECK`, `HYPERFRAMES_NO_AUTO_INSTALL`, `HYPERFRAMES_SKIP_SKILLS` are set for every child; snapshot always runs with `--describe false` (no Gemini call). With no network, none of these could leave anyway. |
| Licences | Hyperframes 0.8.150, Apache-2.0, licence text kept in `licenses/`; see `THIRD_PARTY_NOTICES.md`. Not Remotion. GSAP is **not** included unless the image is built with `WITH_GSAP=1` (its licence is not open source). |

## Operator steps (adding the container on the box)

Do these once, after the Security Reviewer has passed this container. The normal deploy only ships the app image, so
this is a box-side step for your Paperclip session. Run them in the Paperclip checkout on the server (the same folder
the deploy uses), with the server already on a commit that contains this folder.

1. **Check the disk.** Docker's data-root must be on the 200 GB volume (it is since the disk-full incident):
   `docker info --format '{{.DockerRootDir}}'`.
2. **Make the token** (once) and put it in the host's `.env` next to the other `PAPERCLIP_SERVER_*` values:
   ```sh
   echo "PAPERCLIP_SERVER_RENDER_WORKER_TOKEN=$(openssl rand -hex 32)" >> .env
   ```
   If the server image's `node` group is not gid 1000, also set `PAPERCLIP_RENDER_SOCKET_GID=<that gid>` (check with
   `docker compose exec server id node`).
3. **Build the image** (needs internet during the build only; amd64):
   ```sh
   docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml \
     -f docker/docker-compose.render-worker.yml build render-worker
   ```
4. **Start it and give the server the socket** (this recreates `server` once to add the volume and two variables, so
   pick a quiet moment: no bulk job running):
   ```sh
   docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml \
     -f docker/docker-compose.render-worker.yml up -d render-worker-init render-worker server
   ```
   Add `-f docker/docker-compose.render-worker.yml` to the deploy's compose file list
   (`deployPolicy.composeFiles`), or the next deploy recreates `server` without the socket and code renders go back to
   503.
5. **Check it is healthy and isolated:**
   ```sh
   docker compose ps render-worker                        # healthy
   docker inspect -f '{{.HostConfig.NetworkMode}}' $(docker compose ps -q render-worker)   # none
   docker compose exec render-worker id                   # uid=10001
   docker compose exec server ls -l /run/render-control/  # render.sock, srw-rw----
   ```
6. **Test render** from an agent with the `explainer-video` skill (or as a board member): a 20-second infographic
   should pass `check`, give a contact sheet and render to an MP4 in Files. Rendering it twice gives the same file.
7. Note the change in memory (the container, the token's location, the compose file list).

To switch it off: `docker compose ... -f docker/docker-compose.render-worker.yml stop render-worker`. Paperclip then
answers 503 for new jobs; running ones are marked failed when the server next polls them.

## Job API (worker side)

The server's client is `server/src/services/code-render-worker-client.ts`. Every `/v1` call needs
`Authorization: Bearer <token>`.

| Call | Body / answer |
|---|---|
| `POST /v1/jobs` | `{ kind: "check" \| "snapshot" \| "render", label, composition: { entry, files: [{ path, contentBase64 }] }, options: { fps, quality, frames, maxDurationSeconds } }` -> `202` job. `422` with `error` = `bad_path`, `bad_type`, `bad_entry`, `duplicate_path`, `too_large`, `too_long`, `remote_urls`, ... ; `413` too large; `429` queue full. |
| `GET /v1/jobs/:id` | `{ id, kind, status: queued \| running \| done \| failed \| cancelled, createdAt, startedAt, finishedAt, progress: { pct, stage }, error, result: { passed, report, outputContentType, outputBytes, durationSeconds, width, height, frames } }`; `404` unknown (the worker restarted or the result expired). |
| `GET /v1/jobs/:id/output` | The MP4 (render) or contact sheet JPEG (snapshot), streamed with its `Content-Length`. The server streams it to a temp file and from there into storage; it is never held in memory. |
| `DELETE /v1/jobs/:id` | Cancels a waiting/running job, or deletes a finished job's files. Answers the job as above (its `startedAt`/`finishedAt` are what Paperclip charges a cancelled or failed job by). |
| `GET /v1/status` | Queue counts and the length ceiling. |
| `GET /healthz` | Liveness, no token. |

Any job is refused before it runs (`too_long`) when its entry file's `data-start` + `data-duration` name a length
longer than `maxDurationSeconds` (+0.5 s); a render is stopped at its time limit, and refused after it ran if the
video is longer than `maxDurationSeconds` (+0.5 s), larger than the output ceiling, or not a readable video.
`--strict` makes Hyperframes fail on lint errors instead of rendering them.

## Paperclip API (agents and board)

`/api/companies/{companyId}/code-renders`: `POST /` submit, `GET /` recent jobs, `GET /usage` caps and today's use,
`GET /{jobId}` one job (collects it when finished), `POST /{jobId}/cancel`. Agent keys of that company and its board
members only. The `explainer-video` skill documents the body and the stop-and-ask rules for agents.

Server-side caps (environment of the `server` container; defaults in `packages/shared/src/code-renders.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_CODE_RENDER_MAX_VIDEO_SECONDS` | 600 | Longest single render (never above 1800). |
| `PAPERCLIP_CODE_RENDER_AGENT_DAILY_SECONDS` | 1200 | Seconds one agent may use per UTC day: finished video, plus the renderer's time on checks, contact sheets and failed or cancelled jobs. |
| `PAPERCLIP_CODE_RENDER_COMPANY_DAILY_SECONDS` | 3600 | The same, for all of a company's jobs together; agents are refused past it. People are not held to the daily caps, but their jobs count. |
| `PAPERCLIP_CODE_RENDER_MAX_ACTIVE_JOBS` | 2 | Jobs waiting or running per company. |
| `PAPERCLIP_CODE_RENDER_MAX_ASSET_MB` | 100 | Company files sent with one job (the server holds them in memory while it forwards the job). |

## Developing

```sh
# unit + API tests, no browser needed (also in CI: "Test render worker")
pnpm test:render-worker

# a real render outside Docker (Linux x64, ffmpeg installed):
cd docker/render-worker && npm ci --omit=dev --ignore-scripts
HOME=$PWD/.home ./node_modules/.bin/hyperframes browser ensure
RENDER_WORKER_TOKEN=$(openssl rand -hex 32) RENDER_WORKER_JOBS_DIR=/tmp/render-jobs \
  HYPERFRAMES_BROWSER_PATH=$(HOME=$PWD/.home ./node_modules/.bin/hyperframes browser path | tail -n 1) \
  node src/server.mjs        # listens on 127.0.0.1:8790; point PAPERCLIP_SERVER_RENDER_WORKER_URL at it
```

Bumping Hyperframes: pick a release at least two weeks old, update `package.json`, regenerate `package-lock.json`
(`npm install --package-lock-only --ignore-scripts`), re-check its licence and `NOTICE`, update
`THIRD_PARTY_NOTICES.md` and the Chrome version note in the Dockerfile, and render the same composition twice to
confirm the output is still identical. This package is not part of the pnpm workspace, so the monorepo lockfile never
changes.
