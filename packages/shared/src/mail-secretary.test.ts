import { describe, expect, it } from "vitest";
import {
  createMailInboxFilterSchema,
  createMailInboxSchema,
  mailFilterMatches,
  mailFilterValueProblem,
} from "./mail-secretary.js";

describe("mailFilterMatches", () => {
  const nordstrand = { field: "any" as const, matchType: "contains" as const, value: "Nordstrand" };

  it("matches case-insensitively across from/subject/body for field 'any'", () => {
    expect(mailFilterMatches(nordstrand, { from: "a@b.no", subject: "Nordstrand update", body: "" })).toBe(true);
    expect(mailFilterMatches(nordstrand, { from: "a@b.no", subject: "hi", body: "about nordstrand things" })).toBe(true);
    expect(mailFilterMatches(nordstrand, { from: "nordstrand@x.no", subject: "hi", body: "" })).toBe(true);
    expect(mailFilterMatches(nordstrand, { from: "a@b.no", subject: "unrelated", body: "nothing here" })).toBe(false);
  });

  it("restricts a 'from' filter to the from address only", () => {
    const filter = { field: "from" as const, matchType: "contains" as const, value: "acme" };
    expect(mailFilterMatches(filter, { from: "billing@acme.com", subject: "x", body: "" })).toBe(true);
    expect(mailFilterMatches(filter, { from: "billing@other.com", subject: "acme invoice", body: "" })).toBe(false);
  });

  it("domain match checks only the from-address hostname, regardless of field", () => {
    const filter = { field: "subject" as const, matchType: "domain" as const, value: "nordstrand.no" };
    expect(mailFilterMatches(filter, { from: "post@nordstrand.no", subject: "irrelevant", body: "" })).toBe(true);
    expect(mailFilterMatches(filter, { from: "post@mail.nordstrand.no", subject: "irrelevant", body: "" })).toBe(true);
    expect(mailFilterMatches(filter, { from: "post@notnordstrand.no", subject: "irrelevant", body: "" })).toBe(false);
    expect(mailFilterMatches(filter, { from: "post@other.no", subject: "nordstrand.no mentioned", body: "" })).toBe(false);
  });

  it("never matches an empty filter value", () => {
    const filter = { field: "any" as const, matchType: "contains" as const, value: "   " };
    expect(mailFilterMatches(filter, { from: "a@b.no", subject: "", body: "" })).toBe(false);
  });
});

describe("mailFilterValueProblem", () => {
  it("accepts a well-formed domain", () => {
    expect(mailFilterValueProblem("domain", "nordstrand.no")).toBeNull();
  });

  it("rejects a value with @ or a scheme for a domain filter", () => {
    expect(mailFilterValueProblem("domain", "user@nordstrand.no")).not.toBeNull();
    expect(mailFilterValueProblem("domain", "https://nordstrand.no")).not.toBeNull();
  });

  it("has no shape requirement for a contains filter", () => {
    expect(mailFilterValueProblem("contains", "@nordstrand anything")).toBeNull();
  });
});

describe("createMailInboxFilterSchema", () => {
  it("defaults enabled to true and rejects unknown fields", () => {
    const parsed = createMailInboxFilterSchema.parse({
      label: "Nordstrand",
      field: "any",
      matchType: "contains",
      value: "Nordstrand",
    });
    expect(parsed.enabled).toBe(true);
    expect(() =>
      createMailInboxFilterSchema.parse({
        label: "x",
        field: "any",
        matchType: "contains",
        value: "y",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("createMailInboxSchema", () => {
  const base = {
    name: "Filip's inbox",
    agentId: "11111111-1111-1111-1111-111111111111",
    imapHost: "imap.example.com",
    imapUsername: "filip@example.com",
    checkEveryMinutes: 10,
  };

  it("defaults practiceMode to true and delegateAgentId to null", () => {
    const parsed = createMailInboxSchema.parse(base);
    expect(parsed.practiceMode).toBe(true);
    expect(parsed.delegateAgentId).toBeNull();
    expect(parsed.imapPort).toBe(993);
    expect(parsed.imapSecure).toBe(true);
    expect(parsed.imapMailbox).toBe("INBOX");
  });

  it("rejects a check interval under 5 minutes", () => {
    expect(() => createMailInboxSchema.parse({ ...base, checkEveryMinutes: 1 })).toThrow();
  });
});
