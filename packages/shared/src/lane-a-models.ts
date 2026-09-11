/**
 * The models a quick agent (Lane A) may be pointed at, and what each one
 * costs. DUR-3977 made the model a per-agent setting, which means two things
 * that used to be hard-coded now have to move together:
 *
 *   1. which model ids are accepted, and
 *   2. what price the cost line is computed at.
 *
 * They are the same object here on purpose. Before this, `computeCostCents`
 * in server/src/services/lane-a.ts priced every call at Sonnet's rate because
 * Sonnet was the only model that could ever run — with a per-agent model that
 * would silently under- or over-bill the company as soon as an operator
 * picked something else, and the monthly budget in acceptance item 4 is
 * computed from exactly that number.
 *
 * Prices are Anthropic list prices in US dollars per million tokens.
 */
export const LANE_A_MODEL_CATALOGUE = {
  "claude-haiku-4-5": {
    label: "Rask og billig",
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
  },
  "claude-sonnet-5": {
    label: "Standard",
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 10.0,
  },
  "claude-opus-5": {
    label: "Best kvalitet",
    inputUsdPerMillion: 5.0,
    outputUsdPerMillion: 25.0,
  },
} as const satisfies Record<string, { label: string; inputUsdPerMillion: number; outputUsdPerMillion: number }>;

export type LaneAModel = keyof typeof LANE_A_MODEL_CATALOGUE;

/**
 * Derived from the catalogue rather than written out again, so the accepted
 * ids and the priced ids cannot drift apart — the exact failure mode this
 * week keeps producing when two lists have to agree and nothing enforces it.
 */
export const LANE_A_MODELS = Object.keys(LANE_A_MODEL_CATALOGUE) as [LaneAModel, ...LaneAModel[]];

/** What a quick agent uses when the operator has not picked a model. */
export const LANE_A_DEFAULT_MODEL: LaneAModel = "claude-sonnet-5";

export function isLaneAModel(value: unknown): value is LaneAModel {
  return typeof value === "string" && Object.hasOwn(LANE_A_MODEL_CATALOGUE, value);
}

/**
 * Cost in whole cents for one Lane A call. Rounds to the nearest cent, the
 * same way the old Sonnet-only version did, so existing cost rows stay
 * comparable with new ones.
 */
export function laneAModelCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = isLaneAModel(model)
    ? LANE_A_MODEL_CATALOGUE[model]
    : LANE_A_MODEL_CATALOGUE[LANE_A_DEFAULT_MODEL];
  const usd =
    (Math.max(0, inputTokens) / 1_000_000) * pricing.inputUsdPerMillion +
    (Math.max(0, outputTokens) / 1_000_000) * pricing.outputUsdPerMillion;
  return Math.max(0, Math.round(usd * 100));
}

/** Default output-token ceiling for a quick agent that has not set one. */
export const LANE_A_DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** Bounds the operator may choose between for the per-agent output ceiling. */
export const LANE_A_MIN_MAX_OUTPUT_TOKENS = 64;
export const LANE_A_MAX_MAX_OUTPUT_TOKENS = 8192;

/**
 * Default per-agent daily cap on transform calls (acceptance item 4). It is
 * deliberately NOT the 200-turn chat cap: Nordstrand's first run is ~1400
 * descriptions for one vendor in one day, which the chat cap would stop at
 * turn 200. 2000/day leaves room for one full vendor run plus retries, and
 * the operator can lower or raise it per agent.
 */
export const LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP = 2000;
export const LANE_A_MIN_TRANSFORM_DAILY_CALL_CAP = 1;
export const LANE_A_MAX_TRANSFORM_DAILY_CALL_CAP = 100_000;

/**
 * The billing code stamped on every cost row a transform call produces. Three
 * separate things read it: the daily call cap counts rows carrying it, the
 * `lane_a_transform_cents` budget metric sums their cost, and the per-agent
 * usage read-out shows them. Never change it without a backfill — old rows
 * would fall out of all three at once.
 */
export const LANE_A_TRANSFORM_BILLING_CODE = "lane_a_transform";
