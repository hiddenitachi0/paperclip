/**
 * DUR-4070: one dial per agent that gates six scattered tool rights together
 * -- plugin (add-on) tools, business data, company files, web search,
 * browser access, and memory -- instead of each having its own switch with
 * its own gate to remember.
 *
 *   - "limited": none of the six, full stop. Every consumer below refuses or
 *     omits the capability before it even looks at that capability's own
 *     switch/grant (pluginToolGrants, adapterConfig.laneA.webSearch, etc).
 *     This is what makes it safe to hand a not-yet-fully-trusted agent to
 *     someone: whatever else is ticked on its config, Limited overrides it.
 *   - "standard" / "full": both read every other switch exactly as before
 *     this column existed -- this column adds no extra ceiling for either.
 *     They are kept as two distinct values (rather than collapsing to one
 *     "not limited") because the ticket asks for a three-step dial and a
 *     future ticket may give Standard its own ceiling (e.g. capping browser
 *     purchases) without another migration. See "Questions for Filip" in the
 *     DUR-4070 PR description.
 *
 * Defaults to "full" for every agent, existing and newly created, so this
 * column ships with zero behavior change until an operator explicitly turns
 * an agent down to Standard or Limited.
 */

export const LANE_A_TRUST_LEVELS = ["limited", "standard", "full"] as const;

export type LaneATrustLevel = (typeof LANE_A_TRUST_LEVELS)[number];

export const DEFAULT_LANE_A_TRUST_LEVEL: LaneATrustLevel = "full";

export const LANE_A_TRUST_LEVEL_LABELS: Record<LaneATrustLevel, string> = {
  limited: "Limited — no add-on tools, business data, company files, web search, browser access, or memory",
  standard: "Standard — follows this agent's individual tool settings",
  full: "Full — follows this agent's individual tool settings",
};

/** Anything unrecognized (including null/undefined) reads as the default, "full". */
export function normalizeLaneATrustLevel(value: string | null | undefined): LaneATrustLevel {
  return (LANE_A_TRUST_LEVELS as readonly string[]).includes(value ?? "")
    ? (value as LaneATrustLevel)
    : DEFAULT_LANE_A_TRUST_LEVEL;
}

export function isLaneATrustLimited(value: string | null | undefined): boolean {
  return normalizeLaneATrustLevel(value) === "limited";
}
