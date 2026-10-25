import { describe, expect, it } from "vitest";
import {
  aggregateContractTermQuerySchema,
  createContractDeadlineSchema,
  createContractPartySchema,
  createContractSchema,
  defaultLeadTimesDaysForKind,
  updateContractSchema,
  upsertContractTermSchema,
} from "./contracts.js";

describe("contract validators", () => {
  it("defaults lead times: notice kinds 60/30/7, others 30/7", () => {
    expect(defaultLeadTimesDaysForKind("notice_terminate")).toEqual([60, 30, 7]);
    expect(defaultLeadTimesDaysForKind("notice_extend")).toEqual([60, 30, 7]);
    expect(defaultLeadTimesDaysForKind("expiry")).toEqual([30, 7]);
    expect(defaultLeadTimesDaysForKind("payment")).toEqual([30, 7]);
  });

  it("does not let a caller set superseded through a plain update", () => {
    expect(updateContractSchema.safeParse({ status: "superseded" }).success).toBe(false);
    expect(updateContractSchema.safeParse({ status: "active" }).success).toBe(true);
  });

  it("requires a title and a known type to create", () => {
    expect(createContractSchema.safeParse({ title: "Lease", type: "rental_lease" }).success).toBe(true);
    expect(createContractSchema.safeParse({ title: "", type: "rental_lease" }).success).toBe(false);
    expect(createContractSchema.safeParse({ title: "x", type: "marriage" }).success).toBe(false);
  });

  it("rejects dates that do not exist", () => {
    expect(createContractDeadlineSchema.safeParse({ kind: "expiry", dueDate: "2027-02-30" }).success).toBe(false);
    expect(createContractDeadlineSchema.safeParse({ kind: "expiry", dueDate: "2027-02-28" }).success).toBe(true);
    expect(createContractDeadlineSchema.safeParse({ kind: "expiry", dueDate: "28/02/2027" }).success).toBe(false);
  });

  it("needs a party to have an organization or a name", () => {
    expect(createContractPartySchema.safeParse({ role: "vendor" }).success).toBe(false);
    expect(createContractPartySchema.safeParse({ role: "vendor", name: "Acme AS" }).success).toBe(true);
    expect(
      createContractPartySchema.safeParse({ role: "vendor", organizationId: "3f2b8c1e-5d8a-4c3e-9a41-0a6f5b7d9e10" }).success,
    ).toBe(true);
  });

  describe("term values", () => {
    it("accepts a number with a currency", () => {
      expect(upsertContractTermSchema.safeParse({ valueKind: "number", numberValue: 500, currency: "nok" }).success).toBe(true);
    });
    it("accepts a genuine zero", () => {
      expect(upsertContractTermSchema.safeParse({ valueKind: "number", numberValue: 0 }).success).toBe(true);
    });
    it("rejects a number term without a number", () => {
      expect(upsertContractTermSchema.safeParse({ valueKind: "number" }).success).toBe(false);
      expect(upsertContractTermSchema.safeParse({ valueKind: "number", numberValue: null }).success).toBe(false);
    });
    it("rejects non-finite numbers", () => {
      expect(upsertContractTermSchema.safeParse({ valueKind: "number", numberValue: Number.NaN }).success).toBe(false);
      expect(upsertContractTermSchema.safeParse({ valueKind: "number", numberValue: Number.POSITIVE_INFINITY }).success).toBe(false);
    });
    it("rejects a value on not_mentioned / explicitly_none so they can never read as zero", () => {
      for (const valueKind of ["not_mentioned", "explicitly_none"] as const) {
        expect(upsertContractTermSchema.safeParse({ valueKind }).success).toBe(true);
        expect(upsertContractTermSchema.safeParse({ valueKind, numberValue: 0 }).success).toBe(false);
        expect(upsertContractTermSchema.safeParse({ valueKind, textValue: "none" }).success).toBe(false);
        expect(upsertContractTermSchema.safeParse({ valueKind, boolValue: false }).success).toBe(false);
        expect(upsertContractTermSchema.safeParse({ valueKind, currency: "NOK" }).success).toBe(false);
      }
    });
    it("rejects mismatched value fields", () => {
      expect(upsertContractTermSchema.safeParse({ valueKind: "text", textValue: "CPI", numberValue: 1 }).success).toBe(false);
      expect(upsertContractTermSchema.safeParse({ valueKind: "bool", boolValue: true, textValue: "yes" }).success).toBe(false);
      expect(upsertContractTermSchema.safeParse({ valueKind: "bool" }).success).toBe(false);
    });
    it("rejects a malformed currency", () => {
      expect(upsertContractTermSchema.safeParse({ valueKind: "number", numberValue: 1, currency: "NOKK" }).success).toBe(false);
    });
  });

  it("parses the aggregate status filter", () => {
    const ok = aggregateContractTermQuerySchema.parse({ statuses: "active, expired" });
    expect(ok.statuses).toEqual(["active", "expired"]);
    expect(aggregateContractTermQuerySchema.safeParse({ statuses: "active,bogus" }).success).toBe(false);
    expect(aggregateContractTermQuerySchema.parse({}).statuses).toBeUndefined();
  });
});
