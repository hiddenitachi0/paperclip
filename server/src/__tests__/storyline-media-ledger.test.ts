import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, costEvents, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  companyMonthlyMediaSpendCents,
  releaseStorylineMediaSpend,
  reserveStorylineMediaSpend,
  settleSogniStorylineSpend,
  storylineAnimateSpendCode,
  storylineTransitionSpendCode,
} from "../services/storyline-media-ledger.js";

/**
 * DUR-4807 item 4: the storyline monthly AI-media limit is counted from
 * cost_events (which nothing cascades away), company by company, for the
 * current UTC month.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping storyline media ledger tests: ${support.reason ?? "unsupported environment"}`);

d("storyline media spend ledger (DUR-4807)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("storyline-media-ledger");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Co", issuePrefix: `L${id.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return id;
  }

  const hold = (companyId: string, billingCode: string, cents: number, occurredAt = new Date()) =>
    reserveStorylineMediaSpend(db, { companyId, billingCode, provider: "fal", model: "m", cents, agentId: null, createdByUserId: "u", occurredAt });

  it("counts this month's held, settled and legacy storyline rows for one company only, and nothing else", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const now = new Date();
    await hold(a, storylineTransitionSpendCode(randomUUID()), 26);
    await hold(a, storylineAnimateSpendCode(randomUUID()), 40);
    // Last month does not count.
    await hold(a, storylineTransitionSpendCode(randomUUID()), 500, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
    // Rows written before holds were recorded still count.
    const legacy = { provider: "fal", model: "m", occurredAt: now, companyId: a };
    await db.insert(costEvents).values([
      { ...legacy, billingCode: "video-storyline-transition", costCents: 7 },
      { ...legacy, provider: "sogni", billingCode: `video_storyline_transition:${randomUUID()}`, costCents: 3 },
      // Not this limit: shot renders, stills, Media Studio direct, a look-alike code.
      { ...legacy, billingCode: "video-storyline-shot", costCents: 1_000 },
      { ...legacy, billingCode: "video-storyline-still", costCents: 1_000 },
      { ...legacy, billingCode: "media-studio-direct", costCents: 1_000 },
      { ...legacy, billingCode: "videoXstorylineXtransition:x", costCents: 1_000 },
    ]);
    // Another company's spend never counts here.
    await hold(b, storylineTransitionSpendCode(randomUUID()), 900);

    expect(await companyMonthlyMediaSpendCents(db, a, now)).toBe(26 + 40 + 7 + 3);
    expect(await companyMonthlyMediaSpendCents(db, b, now)).toBe(900);
  });

  it("a released hold counts 0 but its row stays; the company's month total follows", async () => {
    const a = await seedCompany();
    const code = storylineTransitionSpendCode(randomUUID());
    await hold(a, code, 26);
    await releaseStorylineMediaSpend(db, a, code);
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, a));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costCents: 0, costMicroUsd: 0 });
    expect(await companyMonthlyMediaSpendCents(db, a, new Date())).toBe(0);
    const [company] = await db.select().from(companies).where(eq(companies.id, a));
    expect(company!.spentMonthlyCents).toBe(0);
  });

  it("Sogni: settles to credits x price, keeps the held estimate without a price, and reports a missing row", async () => {
    const a = await seedCompany();
    const priced = storylineAnimateSpendCode(randomUUID());
    const unpriced = storylineAnimateSpendCode(randomUUID());
    await hold(a, priced, 50);
    await hold(a, unpriced, 50);
    expect(await settleSogniStorylineSpend(db, { companyId: a, billingCode: priced, credits: 10, creditPriceUsd: 0.01 })).toBe(true);
    expect(await settleSogniStorylineSpend(db, { companyId: a, billingCode: unpriced, credits: 10, creditPriceUsd: undefined })).toBe(true);
    expect(await settleSogniStorylineSpend(db, { companyId: a, billingCode: storylineAnimateSpendCode(randomUUID()), credits: 10, creditPriceUsd: 0.01 })).toBe(false);
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, a));
    expect(rows.find((r) => r.billingCode === priced)).toMatchObject({ costCents: 10, costMicroUsd: 100_000, costSource: "converted_from_credits" });
    expect(rows.find((r) => r.billingCode === unpriced)).toMatchObject({ costCents: 50, costSource: "estimate" });
    expect(await companyMonthlyMediaSpendCents(db, a, new Date())).toBe(60);
  });
});
