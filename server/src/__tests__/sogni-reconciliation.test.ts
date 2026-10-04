import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recordSogniCost } from "../services/sogni-cost.js";
import { fetchSogniBalance, reconcileSogniBalance } from "../services/sogni-reconciliation.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const balance = (settled: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ status: "success", data: { spark: { settled } } }), { status }));

describe("fetchSogniBalance", () => {
  it("parses the decimal-string Spark balance and sends a Bearer key", async () => {
    const f = balance("123.5");
    const snap = await fetchSogniBalance(f, "K", new Date(0));
    expect(snap?.spark).toBe(123.5);
    expect(f.mock.calls[0][0]).toBe("https://api.sogni.ai/v4/account/balance");
    expect(f.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer K");
  });
  it("returns null on rejection or odd shape", async () => {
    expect(await fetchSogniBalance(balance("1", 401), "K")).toBeNull();
    expect(await fetchSogniBalance(vi.fn(async () => new Response("{}")), "K")).toBeNull();
  });
});

d("reconcileSogniBalance (DUR-4460)", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const s = await startEmbeddedPostgresTestDatabase("sogni-reconciliation");
    stop = s.cleanup;
    db = createDb(s.connectionString);
  }, 90_000);
  afterAll(async () => { await stop?.(); });

  async function setup() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Co", issuePrefix: `S${id.slice(0, 5).toUpperCase()}` });
    const previous = { spark: 100, at: new Date(Date.now() - 60_000) };
    await recordSogniCost(db, { companyId: id, agentId: null, credits: 10, creditPriceUsd: 0.01, model: "m" });
    return { id, previous };
  }

  it("confirms when the balance drop matches recorded credits", async () => {
    const { id, previous } = await setup();
    const r = await reconcileSogniBalance(db, balance("90"), { companyId: id, apiKey: "K", creditPriceUsd: 0.01, previous, now: new Date(Date.now() + 1000) });
    expect(r.status).toBe("confirmed");
  });
  it("flags a mismatch when more was spent than recorded", async () => {
    const { id, previous } = await setup();
    const r = await reconcileSogniBalance(db, balance("70"), { companyId: id, apiKey: "K", creditPriceUsd: 0.01, previous, now: new Date(Date.now() + 1000) });
    expect(r).toMatchObject({ status: "mismatch" });
    if (r.status === "mismatch") expect(r.deltaCredits).toBeCloseTo(20, 3);
  });
  it("skips without a previous snapshot, price or balance", async () => {
    const { id, previous } = await setup();
    expect(await reconcileSogniBalance(db, balance("90"), { companyId: id, apiKey: "K", creditPriceUsd: 0.01, previous: null })).toMatchObject({ status: "skipped", reason: "no_previous_snapshot" });
    expect(await reconcileSogniBalance(db, balance("90"), { companyId: id, apiKey: "K", creditPriceUsd: 0, previous })).toMatchObject({ reason: "credit_price_not_set" });
    expect(await reconcileSogniBalance(db, balance("90", 401), { companyId: id, apiKey: "K", creditPriceUsd: 0.01, previous })).toMatchObject({ reason: "no_balance" });
  });
});
