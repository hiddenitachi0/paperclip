/**
 * DUR-4013: entrypoint for the `browser-egress` container (design step 2's
 * compose overlay points Chromium's `--proxy-server` at this). Not wired
 * into any compose file in this step -- that overlay is a separate,
 * production-infra task and stays out of this PR -- but the server itself
 * is complete and runnable on its own (`pnpm --filter @paperclipai/browser-worker egress-proxy`).
 *
 * Binds the port the design specifies (3128) and blocks the operator's
 * tailnet (`*.ts.net`) plus the instance's own public URL host on top of the
 * address checks in egress-proxy.ts, so a page cannot make the browser call
 * back into the Paperclip server itself even if that host happens to
 * resolve publicly.
 */

import { createEgressProxyServer, type EgressLogEntry } from "../egress-proxy.js";

const PORT = Number(process.env.PAPERCLIP_BROWSER_EGRESS_PORT ?? 3128);

function blockedHostSuffixes(): string[] {
  const suffixes = ["ts.net"];
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL;
  if (publicUrl) {
    try {
      suffixes.push(new URL(publicUrl).hostname);
    } catch {
      // malformed PAPERCLIP_PUBLIC_URL: nothing to add, address checks still apply
    }
  }
  return suffixes;
}

function logEntry(entry: EgressLogEntry): void {
  const line = {
    ts: new Date().toISOString(),
    ...entry,
  };
  // eslint-disable-next-line no-console -- this process has no other log sink
  console.log(JSON.stringify(line));
}

const server = createEgressProxyServer({
  blockedHostSuffixes: blockedHostSuffixes(),
  onLog: logEntry,
});

server.listen(PORT, () => {
  logEntry({ host: "0.0.0.0", port: PORT, protocol: "http", allowed: true, refusalReason: undefined });
  // eslint-disable-next-line no-console
  console.log(`browser-egress listening on :${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
