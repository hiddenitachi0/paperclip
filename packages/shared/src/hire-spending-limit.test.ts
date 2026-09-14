import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS,
  hireMonthlySpendingLimitCentsFromPayload,
} from "./hire-spending-limit.js";
import { createAgentHireSchema, createAgentSchema, updateAgentSchema } from "./validators/agent.js";

// DUR-3976: a new hire starts with a $50 monthly limit unless someone
// explicitly says otherwise.
describe("standard monthly spending limit for a new hire", () => {
  it("is $50, the operator's decision", () => {
    expect(DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS).toBe(5000);
  });

  it("is what a CEO-proposed hire gets when it leaves the limit out", () => {
    const body = { name: "Analyst", adapterType: "process" };
    expect(createAgentHireSchema.parse(body).budgetMonthlyCents).toBe(5000);
    expect(createAgentSchema.parse(body).budgetMonthlyCents).toBe(5000);
  });

  it("keeps an explicit 0 (no limit) as 0, rather than overriding the choice", () => {
    const body = { name: "Analyst", adapterType: "process", budgetMonthlyCents: 0 };
    expect(createAgentHireSchema.parse(body).budgetMonthlyCents).toBe(0);
  });

  it("keeps an explicit amount", () => {
    const body = { name: "Analyst", adapterType: "process", budgetMonthlyCents: 30000 };
    expect(createAgentHireSchema.parse(body).budgetMonthlyCents).toBe(30000);
  });

  it("refuses an amount the database column cannot hold", () => {
    const body = { name: "Analyst", adapterType: "process", budgetMonthlyCents: 2_147_483_648 };
    expect(createAgentHireSchema.safeParse(body).success).toBe(false);
  });

  // The operator set every existing agent's limit by hand on 12 Sep. An
  // edit that does not mention the limit must never write one.
  it("never fills in a limit when an existing agent is edited", () => {
    const parsed = updateAgentSchema.parse({ name: "Renamed" });
    expect(Object.hasOwn(parsed, "budgetMonthlyCents")).toBe(false);
  });
});

describe("hireMonthlySpendingLimitCentsFromPayload", () => {
  it("reads the amount on the card", () => {
    expect(hireMonthlySpendingLimitCentsFromPayload({ budgetMonthlyCents: 12345 })).toBe(12345);
  });

  it("reads an explicit 0 as no limit", () => {
    expect(hireMonthlySpendingLimitCentsFromPayload({ budgetMonthlyCents: 0 })).toBe(0);
  });

  it("reads a card that does not say as the standard limit, never as no limit", () => {
    expect(hireMonthlySpendingLimitCentsFromPayload({})).toBe(5000);
    expect(hireMonthlySpendingLimitCentsFromPayload(null)).toBe(5000);
    expect(hireMonthlySpendingLimitCentsFromPayload({ budgetMonthlyCents: "100" })).toBe(5000);
    expect(hireMonthlySpendingLimitCentsFromPayload({ budgetMonthlyCents: Number.NaN })).toBe(5000);
  });

  it("never reads a negative or fractional amount literally", () => {
    expect(hireMonthlySpendingLimitCentsFromPayload({ budgetMonthlyCents: -10 })).toBe(0);
    expect(hireMonthlySpendingLimitCentsFromPayload({ budgetMonthlyCents: 99.9 })).toBe(99);
  });
});
