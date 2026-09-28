/**
 * DUR-4013: the browser egress proxy. Every outbound byte the browser
 * container sends leaves through this proxy -- Chromium is launched with
 * `--proxy-server=http://browser-egress:3128` and the container itself has
 * no other route out (network `browser-internal` is `internal: true`), so
 * bypassing this file is not a configuration mistake the browser can make,
 * it is a network-level impossibility (enforced by the compose overlay in
 * step 2, out of scope here).
 *
 * What this file enforces, per the design:
 *  - resolves DNS itself (never trusts a pre-resolved address from the client)
 *  - refuses any resolved address `isNonPublicAddress` flags: RFC1918,
 *    loopback, link-local incl. the 169.254.169.254 cloud metadata address,
 *    carrier-grade NAT 100.64.0.0/10 (a tailnet lives here), multicast,
 *    reserved space, NAT64
 *  - connects to the address it just checked, not to the hostname again --
 *    the classic DNS-rebinding TOCTOU window (check a safe answer, then let
 *    the OS resolve again at connect time to something private) is closed
 *    by pinning the checked IP into the outbound socket
 *  - ports 80 and 443 only
 *  - refuses `*.ts.net` (the operator's tailnet) and the instance's own
 *    public URL host explicitly, on top of the address check (a public DNS
 *    name can legitimately resolve to a public address and still be a host
 *    we must never let the browser reach)
 *  - logs host, port and byte counts for every decision, allowed or refused
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { isNonPublicAddress } from "@paperclipai/adapter-utils/public-address";

export const ALLOWED_PROXY_PORTS: ReadonlySet<number> = new Set([80, 443]);

export interface DnsLookupResult {
  address: string;
  family: number;
}

export type DnsLookupAll = (hostname: string) => Promise<DnsLookupResult[]>;

const defaultLookup: DnsLookupAll = (hostname) => dnsLookup(hostname, { all: true });

export type EgressRefusalReason =
  | "invalid_target"
  | "port_not_allowed"
  | "host_blocked"
  | "dns_failed"
  | "address_not_public"
  | "connect_failed";

export interface EgressLogEntry {
  host: string;
  port: number;
  protocol: "connect" | "http";
  allowed: boolean;
  refusalReason?: EgressRefusalReason;
  resolvedAddress?: string;
  bytesUp?: number;
  bytesDown?: number;
}

export interface EgressProxyOptions {
  /**
   * Hostname suffixes to refuse regardless of what address they resolve to,
   * matched case-insensitively as ".suffix" or an exact match (so
   * "ts.net" refuses both "ts.net" and "foo.ts.net", never "notts.net").
   * The design calls out the operator's tailnet (`*.ts.net`) and the
   * instance's own public URL host.
   */
  blockedHostSuffixes?: readonly string[];
  lookup?: DnsLookupAll;
  isBlockedAddress?: (ip: string) => boolean;
  onLog?: (entry: EgressLogEntry) => void;
  /** Test-only seam: dial this instead of the real resolved address. */
  testOnlyDial?: (resolvedAddress: string, port: number) => { host: string; port: number };
}

export interface HostCheckResult {
  ok: boolean;
  resolvedAddress?: string;
  reason?: EgressRefusalReason;
}

function isHostBlocked(hostname: string, suffixes: readonly string[]): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return suffixes.some((raw) => {
    const suffix = raw.toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
    return lower === suffix || lower.endsWith(`.${suffix}`);
  });
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/**
 * The single decision point: is this host:port allowed, and if so what
 * address should the outbound socket actually dial. Exported standalone
 * (independent of the server plumbing below) so the refusal logic itself is
 * directly unit-testable without opening a real TCP connection.
 */
export async function checkHostAllowed(
  hostname: string,
  port: number,
  options: EgressProxyOptions = {},
): Promise<HostCheckResult> {
  if (!hostname) return { ok: false, reason: "invalid_target" };
  if (!ALLOWED_PROXY_PORTS.has(port)) return { ok: false, reason: "port_not_allowed" };

  const suffixes = options.blockedHostSuffixes ?? [];
  if (isHostBlocked(hostname, suffixes)) return { ok: false, reason: "host_blocked" };

  const isBlockedAddress = options.isBlockedAddress ?? isNonPublicAddress;

  if (isIpLiteral(hostname)) {
    // A literal IP the client asked to connect to directly -- check it as-is,
    // there is no DNS step to pin against rebinding.
    if (isBlockedAddress(hostname)) return { ok: false, reason: "address_not_public" };
    return { ok: true, resolvedAddress: hostname };
  }

  const lookup = options.lookup ?? defaultLookup;
  let results: DnsLookupResult[];
  try {
    results = await lookup(hostname);
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  if (!results || results.length === 0) return { ok: false, reason: "dns_failed" };

  const publicAddress = results.find((entry) => !isBlockedAddress(entry.address));
  if (!publicAddress) return { ok: false, reason: "address_not_public" };

  return { ok: true, resolvedAddress: publicAddress.address };
}

/**
 * Parses a CONNECT request line target ("host:port", the only form defined
 * by RFC 7231 for CONNECT) into its parts.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const trimmed = target.trim();
  // Bracketed IPv6 form: "[::1]:443" -- the host itself contains colons, so
  // it must be matched as a bracketed group before the plain "host:port" case.
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
  if (bracketed) {
    const host = bracketed[1]!;
    const port = Number(bracketed[2]);
    if (!host || !Number.isFinite(port)) return null;
    return { host, port };
  }
  const match = /^([^\s:]+):(\d+)$/.exec(trimmed);
  if (!match) return null;
  const host = match[1]!;
  const port = Number(match[2]);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

/**
 * Parses an absolute-URI HTTP proxy request target ("http://host[:port]/path"),
 * the form a browser sends for plain (non-TLS) requests through an explicit
 * proxy.
 */
export function parseAbsoluteHttpTarget(url: string): { host: string; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

function writeAndDestroy(socket: Duplex, statusLine: string): void {
  try {
    socket.write(statusLine);
  } catch {
    // socket already gone; nothing to do
  }
  socket.destroy();
}

async function handleConnect(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  options: EgressProxyOptions,
): Promise<void> {
  const target = parseConnectTarget(req.url ?? "");
  if (!target) {
    writeAndDestroy(clientSocket, "HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const { host, port } = target;
  const check = await checkHostAllowed(host, port, options);
  options.onLog?.({ host, port, protocol: "connect", allowed: check.ok, refusalReason: check.reason, resolvedAddress: check.resolvedAddress });
  if (!check.ok || !check.resolvedAddress) {
    writeAndDestroy(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  const dialTarget = options.testOnlyDial
    ? options.testOnlyDial(check.resolvedAddress, port)
    : { host: check.resolvedAddress, port };

  const upstream = netConnect(dialTarget.port, dialTarget.host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  let bytesUp = 0;
  let bytesDown = 0;
  clientSocket.on("data", (chunk: Buffer) => {
    bytesUp += chunk.length;
  });
  upstream.on("data", (chunk: Buffer) => {
    bytesDown += chunk.length;
  });

  const finish = () => {
    options.onLog?.({ host, port, protocol: "connect", allowed: true, resolvedAddress: check.resolvedAddress, bytesUp, bytesDown });
  };
  upstream.on("close", finish);
  upstream.on("error", () => {
    options.onLog?.({ host, port, protocol: "connect", allowed: false, refusalReason: "connect_failed" });
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: EgressProxyOptions,
): Promise<void> {
  const target = parseAbsoluteHttpTarget(req.url ?? "");
  if (!target) {
    res.writeHead(400).end("Bad Request");
    return;
  }
  const { host, port } = target;
  const check = await checkHostAllowed(host, port, options);
  options.onLog?.({ host, port, protocol: "http", allowed: check.ok, refusalReason: check.reason, resolvedAddress: check.resolvedAddress });
  if (!check.ok || !check.resolvedAddress) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  const dialTarget = options.testOnlyDial
    ? options.testOnlyDial(check.resolvedAddress, port)
    : { host: check.resolvedAddress, port };

  const { request: httpRequest } = await import("node:http");
  const headers = { ...req.headers, host };
  const upstreamReq = httpRequest(
    { host: dialTarget.host, port: dialTarget.port, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });
  req.pipe(upstreamReq);
}

/**
 * Creates the egress proxy HTTP server. Handles CONNECT (HTTPS tunneling,
 * the normal case for a browser behind an explicit proxy) and plain
 * absolute-URI HTTP requests. Does not call `listen()` -- the caller decides
 * the port (the entrypoint binds 3128 per the design).
 */
export function createEgressProxyServer(options: EgressProxyOptions = {}): Server {
  const server = createServer((req, res) => {
    void handleHttpRequest(req, res, options);
  });
  server.on("connect", (req, clientSocket, head) => {
    void handleConnect(req, clientSocket, head, options);
  });
  return server;
}
