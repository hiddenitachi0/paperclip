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
  fetchImpl?: typeof fetch;
  /** How long a host's parsed robots.txt is cached before being re-fetched. */
  cacheTtlMs?: number;
  userAgent: string;
}

const DEFAULT_CACHE_TTL_MS = 60 * 60_000;

export interface RobotsTxtChecker {
  isAllowed(url: string): Promise<boolean>;
}

/** Fetches and caches robots.txt per host, serving `isAllowed` off the cache. */
export function createRobotsTxtChecker(options: RobotsTxtCheckerOptions): RobotsTxtChecker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { robots: ParsedRobots; expiresAt: number }>();

  async function getRobotsForOrigin(origin: string): Promise<ParsedRobots> {
    const cached = cache.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached.robots;

    let robots: ParsedRobots;
    try {
      const response = await fetchImpl(`${origin}/robots.txt`, { headers: { "User-Agent": options.userAgent } });
      robots = response.ok ? parseRobotsTxt(await response.text()) : parseRobotsTxt("");
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
