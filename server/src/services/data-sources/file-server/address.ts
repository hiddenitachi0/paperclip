import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicLookingHostName } from "@paperclipai/shared";
import { DNS_LOOKUP_TIMEOUT_MS, isNonPublicAddress, type DnsLookupAll } from "../../safe-outbound-fetch.js";
import { FileServerError } from "./errors.js";

/**
 * DUR-3997 (files on a server): the same address rule the HTTP outbound guard
 * applies, for a transport that is not HTTP.
 *
 * The host is resolved once; every address it resolves to must be an ordinary
 * public unicast address (isNonPublicAddress refuses private ranges,
 * loopback, link-local, carrier-grade NAT where a tailnet lives, and the
 * rest); and the FIRST public address is pinned: the socket is opened to that
 * address, never to a name, so a DNS answer that changes between the check
 * and the connect cannot move the connection somewhere private.
 */

export interface PinnedFileServerAddress {
  /** The DNS name, for TLS identity checks and for messages. */
  host: string;
  /** The one public address the socket is opened to. */
  address: string;
  family: 4 | 6;
}

export interface ResolveFileServerAddressDeps {
  /** DNS resolver; tests inject one. Defaults to node:dns lookup({ all: true }). */
  lookup?: DnsLookupAll;
}

const defaultLookup: DnsLookupAll = (hostname) => dnsLookup(hostname, { all: true });

export async function resolveFileServerAddress(
  host: string,
  deps: ResolveFileServerAddressDeps = {},
): Promise<PinnedFileServerAddress> {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (!isPublicLookingHostName(name)) {
    throw new FileServerError(
      "address_not_public",
      `${name || "(empty)"} is not a public server name. Use the server's public DNS name, not an IP address or an internal name.`,
    );
  }
  const lookup = deps.lookup ?? defaultLookup;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FileServerError("dns_failed", `Looking up ${name} took too long.`)), DNS_LOOKUP_TIMEOUT_MS);
  });
  let results: Array<{ address: string; family: number }>;
  try {
    results = await Promise.race([lookup(name), timeout]);
  } catch (error) {
    if (error instanceof FileServerError) throw error;
    throw new FileServerError("dns_failed", `Could not find the server ${name}.`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new FileServerError("dns_failed", `Could not find the server ${name}.`);
  }
  // Every address must be public, not only the one used: a name that also
  // points somewhere private is refused as a whole.
  for (const entry of results) {
    if (typeof entry?.address !== "string" || isIP(entry.address) === 0 || isNonPublicAddress(entry.address)) {
      throw new FileServerError(
        "address_not_public",
        `${name} points to an address inside a private network and will not be contacted.`,
      );
    }
  }
  const first = results[0]!;
  return { host: name, address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

/**
 * Whether a data-connection address a server hands back (FTP passive mode)
 * is the same peer the control connection is talking to. Compares IPv4 with
 * its IPv4-mapped IPv6 form as equal.
 */
export function isSamePeerAddress(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const lower = value.trim().toLowerCase();
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    return mapped?.[1] ?? lower;
  };
  return normalize(a) === normalize(b);
}
