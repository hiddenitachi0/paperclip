/**
 * DUR-4037 (Maja browser step 4): the one place that turns a page URL into the
 * "merchant registrable domain" the booking gate binds a clearance to (design
 * section 3: "merchant registrable domain (tldts)"). A naive `hostname.split
 * (".").slice(-2)` is wrong for multi-part public suffixes (a site on
 * "example.co.uk" would bind to "co.uk", which also matches every other
 * ".co.uk" site) and is exactly the kind of mistake that would let a
 * malicious page's iframe/redirect trick the gate into treating two different
 * merchants as the same one. `tldts` carries the public suffix list so this
 * cannot happen.
 */

import { getDomain } from "tldts";

/**
 * Returns the registrable domain (e.g. "booking.example.com" -> "example.com",
 * "example.co.uk" -> "example.co.uk"), or null when the URL has no host or the
 * host is not a domain tldts recognizes (bare IP, localhost, etc.) -- callers
 * must treat null as "cannot verify," never as "any site is fine."
 */
export function registrableDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return getDomain(host, { allowPrivateDomains: false }) ?? null;
  } catch {
    return null;
  }
}
