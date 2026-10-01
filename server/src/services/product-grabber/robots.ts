/**
 * DUR-4187: a small, dependency-free robots.txt checker for the product
 * grabber's fetch path. Implements the common subset every major crawler
 * agrees on (User-agent groups, Allow/Disallow, longest-match-wins, Allow
 * wins a tie) -- enough to make a conservative allow/deny call without
 * pulling in a parser library for one file.
 *
 * A host with no robots.txt (404/network error) is treated as "allow
 * everything", per the de facto standard every crawler follows. A host that
 * answers but whose body cannot be parsed meaningfully is also treated as
 * "allow everything" -- fail open on the file's own absence/garbage, never
 * fail closed and block every fetch globally over a transient robots.txt
 * hiccup. The real safety net is per-path group matching below, which fails
 * closed on an explicit `Disallow`.
 */

export interface RobotsRule {
  path: string;
  allow: boolean;
}

interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  isAllowed(path: string, userAgent: string): boolean;
}

function matchesUserAgent(group: RobotsGroup, userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return group.userAgents.some((candidate) => candidate === "*" || ua.includes(candidate));
}

/** Parses robots.txt text into a group list, most specific match picked per call. */
export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let sawRuleSinceLastAgentBlock = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      if (current && sawRuleSinceLastAgentBlock) {
        // Still in the same group if the previous line was also a user-agent.
        current = null;
      }
      if (!current) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        sawRuleSinceLastAgentBlock = false;
      }
      current.userAgents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    sawRuleSinceLastAgentBlock = true;

    if (field === "allow") {
      current.rules.push({ path: value, allow: true });
    } else if (field === "disallow") {
      if (value === "") continue; // explicit "Disallow:" with no path means allow everything
      current.rules.push({ path: value, allow: false });
    }
  }

  return {
    isAllowed(path: string, userAgent: string): boolean {
      const matching = groups.filter((g) => matchesUserAgent(g, userAgent));
      const group = matching.find((g) => !g.userAgents.includes("*")) ?? matching.find((g) => g.userAgents.includes("*"));
      if (!group) return true;

      let best: RobotsRule | null = null;
      for (const rule of group.rules) {
        if (!path.startsWith(rule.path)) continue;
        if (!best || rule.path.length > best.path.length) best = rule;
        else if (rule.path.length === best.path.length && rule.allow) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

export interface RobotsTxtCheckerOptions {
  /**
   * Overridable in tests to stub the network call. When NOT supplied, the real
   * implementation pins the TCP connection to the already-resolved, already-vetted
   * address from `lookupImpl` (see `createPinnedFetch` below) -- it does not let the
   * HTTP client re-resolve the hostname and potentially land on a different address
   * than the one that was checked (the DNS-rebinding TOCTOU gap this module exists
   * to close). A caller-supplied `fetchImpl` bypasses pinning, same as before.
   */
  fetchImpl?: typeof fetch;
  /** Resolves a hostname to its addresses. Overridable in tests; defaults to a real DNS lookup. */
  lookupImpl?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** How long a host's parsed robots.txt is cached before being re-fetched. */
  cacheTtlMs?: number;
  userAgent: string;
}

const DEFAULT_CACHE_TTL_MS = 60 * 60_000;

export interface RobotsTxtChecker {
  isAllowed(url: string): Promise<boolean>;
}

/**
 * True for loopback/private/link-local/unique-local addresses, including the
 * cloud metadata address -- the same ranges `watcherWebPageUrlProblem`
 * (packages/shared/src/watchers.ts) rejects as literal hostnames. Checked
 * here against the *resolved* address, not the typed hostname, because this
 * is the one fetch in the watcher/product-grabber path that still runs
 * directly from the server process rather than through the browser-egress
 * proxy -- so it is the one spot DNS rebinding (a hostname that only
 * resolves to an internal address at request time) can reach.
 */
function isDisallowedAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local, incl. cloud metadata
      a === 0
    );
  }
  const host = address.toLowerCase();
  return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
}

/**
 * Builds a one-shot `fetch`-shaped function whose TCP connection is pinned to `address`
 * via a custom `lookup`, so the HTTP client cannot perform its own, independent DNS
 * resolution of the hostname at connect time. Without this, checking `lookupImpl(hostname)`
 * and then calling plain `fetch(url)` are two unrelated DNS queries -- exactly what a
 * DNS-rebinding attacker needs: answer the first (check) query with a public address and
 * the second (connect) query, moments later, with a private/metadata one. Pinning closes
 * that gap by reusing the one resolution that was actually vetted.
 *
 * Host/SNI/cert validation are unaffected: `hostname` in the request options stays the
 * typed hostname, only `lookup` is overridden, so TLS still validates the certificate
 * against the real hostname, not the pinned IP.
 */
/** Exported only for the pinning test below -- not part of the module's public surface. */
export function createPinnedFetch(address: string, family: number): typeof fetch {
  return async function pinnedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const isHttps = url.protocol === "https:";
    const transportModule = isHttps ? await import("node:https") : await import("node:http");
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of new Headers(init.headers)) headers[key] = value;
    }

    return new Promise<Response>((resolve, reject) => {
      const req = transportModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          headers,
          timeout: 10_000,
          lookup: (_hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) =>
            callback(null, address, family),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 }));
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("robots.txt fetch timed out")));
      req.on("error", reject);
      req.end();
    });
  };
}

/** Fetches and caches robots.txt per host, serving `isAllowed` off the cache. */
export function createRobotsTxtChecker(options: RobotsTxtCheckerOptions): RobotsTxtChecker {
  // A caller-supplied fetchImpl (tests) is used as-is, unpinned. The production default
  // goes through createPinnedFetch per-request instead, once an address has been vetted.
  const callerFetchImpl = options.fetchImpl;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { robots: ParsedRobots; expiresAt: number }>();
  let lookupImpl = options.lookupImpl;

  async function resolveAddresses(hostname: string): Promise<{ address: string; family: number }[] | null> {
    if (!lookupImpl) {
      const dns = await import("node:dns/promises");
      lookupImpl = (host) => dns.lookup(host, { all: true, verbatim: true });
    }
    try {
      return await lookupImpl(hostname);
    } catch {
      // Can't resolve -- nothing to fetch either way; let the normal 404/error path fail open below.
      return null;
    }
  }

  async function getRobotsForOrigin(origin: string): Promise<ParsedRobots> {
    const cached = cache.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached.robots;

    let robots: ParsedRobots;
    try {
      const hostname = new URL(origin).hostname;
      const addresses = await resolveAddresses(hostname);
      const vetted = addresses?.find(({ address, family }) => !isDisallowedAddress(address, family));
      if (addresses && !vetted) {
        // Every resolved address is loopback/private/link-local/metadata (whether typed
        // that way or only resolving that way at request time, i.e. DNS rebinding). Skip
        // the direct fetch; the real page fetch is proxied through Crawl4AI/browser-egress
        // separately and gets its own check there.
        robots = parseRobotsTxt("");
      } else {
        const fetchImpl = callerFetchImpl ?? (vetted ? createPinnedFetch(vetted.address, vetted.family) : fetch);
        const response = await fetchImpl(`${origin}/robots.txt`, { headers: { "User-Agent": options.userAgent } });
        robots = response.ok ? parseRobotsTxt(await response.text()) : parseRobotsTxt("");
      }
    } catch {
      robots = parseRobotsTxt("");
    }
    cache.set(origin, { robots, expiresAt: Date.now() + cacheTtlMs });
    return robots;
  }

  return {
    async isAllowed(url: string): Promise<boolean> {
      const parsed = new URL(url);
      const robots = await getRobotsForOrigin(parsed.origin);
      return robots.isAllowed(parsed.pathname + parsed.search, options.userAgent);
    },
  };
}
