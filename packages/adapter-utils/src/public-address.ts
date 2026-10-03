import { isIP } from "node:net";

/**
 * Address-safety checks shared by every outbound-call guard: the server's
 * plugin/business-data fetch guard (server/src/services/safe-outbound-fetch.ts,
 * DUR-3972/DUR-3997), the file-server data source, and the browser egress
 * proxy (DUR-4013). Moved here so a non-server consumer (the browser worker
 * container, which does not depend on the server package) can enforce the
 * same rules without importing server code.
 */

/**
 * Check if an IP address is in a private/reserved range (RFC 1918, loopback,
 * link-local, etc.) that outbound calls should never be able to reach.
 *
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) which Node's
 * dns.lookup may return depending on OS configuration.
 */
export function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) and re-check as IPv4
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) return isPrivateIP(v4MappedMatch[1]);

  // IPv4 patterns
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;                   // loopback
  if (ip.startsWith("169.254.")) return true;               // link-local
  if (ip === "0.0.0.0") return true;

  // IPv6 patterns
  if (lower === "::1") return true;                          // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;                 // link-local
  if (lower === "::") return true;

  return false;
}

/**
 * The stricter address rule for outbound calls made on someone else's behalf
 * (business-data connections, the browser egress proxy): anything that is
 * not an ordinary public unicast address is refused. On top of isPrivateIP
 * this refuses 0.0.0.0/8, carrier-grade NAT 100.64.0.0/10 (Tailscale/tailnet
 * addresses live here), 192.0.0.0/24, the benchmarking range 198.18.0.0/15,
 * multicast and reserved space, IPv6 multicast, NAT64 and any IPv4-mapped
 * form of those.
 */
export function isNonPublicAddress(ip: string): boolean {
  if (isPrivateIP(ip)) return true;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && mapped[1]) return isNonPublicAddress(mapped[1]);

  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map((part) => Number.parseInt(part, 10)) as [number, number, number, number];
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  if (isIP(ip) === 6) {
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("64:ff9b:")) return true; // NAT64
    if (lower.startsWith("::ffff:")) return true; // any other mapped form
    if (lower.startsWith("2001:db8:")) return true; // documentation
    return false;
  }
  // Not an IP literal at all: never treat as safe.
  return true;
}
