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

/**
 * Security fix (DUR-4045 review of DUR-4037): the registrable domain alone
 * is too coarse to bind a booking clearance to -- it let one approved
 * booking's clearance cover any final click anywhere on the same domain for
 * up to 30 minutes (a different page, a different form, a different
 * merchant flow behind the same host). Returns "origin + pathname" -- not
 * the query string, which a merchant may vary per request without it being
 * a materially different page, and not the fragment -- or null when the URL
 * cannot be parsed. Callers must treat null as "cannot verify."
 */
export function pageUrlKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
