import { describe, expect, it } from "vitest";
import {
  MASK_TOKEN,
  maskAddresses,
  maskEmails,
  maskKeysAndTokens,
  maskMoney,
  maskNames,
  maskPhones,
  maskText,
} from "./presentationMasking";

describe("maskMoney", () => {
  it("masks en-format currency amounts", () => {
    expect(maskMoney("Total: $1,234.56 due")).toBe(`Total: ${MASK_TOKEN} due`);
    expect(maskMoney("Invoice is 1,234.56 USD")).toBe(`Invoice is ${MASK_TOKEN}`);
  });

  it("masks nb-NO format currency amounts", () => {
    expect(maskMoney("Beløp: kr 1.234,56")).toBe(`Beløp: ${MASK_TOKEN}`);
    expect(maskMoney("Totalt 1 234,56 kr")).toBe(`Totalt ${MASK_TOKEN}`);
  });

  it("masks percentages", () => {
    expect(maskMoney("Margin is 45%")).toBe(`Margin is ${MASK_TOKEN}`);
    expect(maskMoney("Margin is 12,5 %")).toBe(`Margin is ${MASK_TOKEN}`);
  });

  it("masks bare numbers next to business words even without a currency unit", () => {
    expect(maskMoney("revenue: 84000 this month")).toBe(`revenue: ${MASK_TOKEN} this month`);
    expect(maskMoney("Payroll 12 500")).toBe(`Payroll ${MASK_TOKEN}`);
  });

  it("leaves unrelated numbers alone outside strict mode", () => {
    expect(maskMoney("Task #1234 has 3 comments")).toBe("Task #1234 has 3 comments");
  });

  it("in strict mode masks every large number", () => {
    expect(maskMoney("Task #1234 has 3 comments", { strict: true })).toBe(`Task #${MASK_TOKEN} has 3 comments`);
  });
});

describe("maskEmails", () => {
  it("masks email addresses", () => {
    expect(maskEmails("Contact filip@nordstrand.no now")).toBe(`Contact ${MASK_TOKEN} now`);
  });

  it("leaves text without an email untouched", () => {
    expect(maskEmails("No contact info here")).toBe("No contact info here");
  });
});

describe("maskPhones", () => {
  it("masks international and local phone numbers", () => {
    expect(maskPhones("Call +47 912 34 567 now")).toBe(`Call ${MASK_TOKEN} now`);
    expect(maskPhones("Call 91234567 now")).toBe(`Call ${MASK_TOKEN} now`);
  });

  it("does not mask short numbers", () => {
    expect(maskPhones("Room 42")).toBe("Room 42");
  });
});

describe("maskAddresses", () => {
  it("masks English-style street addresses", () => {
    expect(maskAddresses("Ship to 221B Baker Street please")).toBe(`Ship to ${MASK_TOKEN} please`);
  });

  it("masks Norwegian-style street addresses", () => {
    expect(maskAddresses("Besøk Storgata 12 i dag")).toBe(`Besøk ${MASK_TOKEN} i dag`);
  });
});

describe("maskKeysAndTokens", () => {
  it("masks common provider key prefixes", () => {
    expect(maskKeysAndTokens("key=sk-abcdefghij1234567890")).toBe(`key=${MASK_TOKEN}`);
  });

  it("masks long opaque alphanumeric strings", () => {
    expect(maskKeysAndTokens("token: aZ9bC8dE7fG6hH5iJ4kL3mN2")).toBe(`token: ${MASK_TOKEN}`);
  });

  it("leaves short normal words untouched", () => {
    expect(maskKeysAndTokens("the quick brown fox")).toBe("the quick brown fox");
  });
});

describe("maskNames", () => {
  it("masks a sensitive name", () => {
    expect(maskNames("Reported by Jane Doe today", { names: ["Jane Doe"] })).toBe(
      `Reported by ${MASK_TOKEN} today`,
    );
  });

  it("never masks a name on the keep list", () => {
    expect(
      maskNames("Filip approved this for Jane Doe", {
        names: ["Filip", "Jane Doe"],
        keepList: ["Filip"],
      }),
    ).toBe(`Filip approved this for ${MASK_TOKEN}`);
  });

  it("is case-insensitive and keep-list match is case-insensitive too", () => {
    expect(
      maskNames("filip and Jane Doe", { names: ["Filip", "Jane Doe"], keepList: ["FILIP"] }),
    ).toBe(`filip and ${MASK_TOKEN}`);
  });

  it("does nothing when there are no names to mask", () => {
    expect(maskNames("hello world", { names: [] })).toBe("hello world");
  });
});

describe("maskText", () => {
  it("combines all masking passes", () => {
    const input = "Contact filip@nordstrand.no, revenue 1 234 567 kr, key sk-abcdefghij1234567890";
    const output = maskText(input, { extraMaskedNames: [] });
    expect(output).not.toContain("filip@nordstrand.no");
    expect(output).not.toContain("1 234 567");
    expect(output).not.toContain("sk-abcdefghij1234567890");
  });

  it("respects the keep list for extra masked names", () => {
    const output = maskText("Nordstrand AS, run by Filip Example", {
      extraMaskedNames: ["Filip Example"],
      keepList: ["Filip Example"],
    });
    expect(output).toContain("Filip Example");
  });

  it("masks extra configured names when not on the keep list", () => {
    const output = maskText("Spoke with Kari Nordmann yesterday", {
      extraMaskedNames: ["Kari Nordmann"],
    });
    expect(output).toBe(`Spoke with ${MASK_TOKEN} yesterday`);
  });

  it("returns empty/undefined-ish input unchanged", () => {
    expect(maskText("")).toBe("");
  });
});
