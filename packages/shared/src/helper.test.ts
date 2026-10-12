import { describe, expect, it } from "vitest";
import { HELPER_MASK, capHelperText, helperAskSchema, maskSecretLikeText } from "./helper.js";

describe("maskSecretLikeText", () => {
  it("masks key-shaped values and labelled secrets", () => {
    const masked = maskSecretLikeText(
      [
        "openai sk-proj-abcdefghijklmnop",
        "google AIzaSyA1234567890abcdefghijklmn",
        "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop",
        "password: Tr0ub4dor&3",
        "api_key=abc123def456",
        "random a8F3kL9qP2xZ7mN4vB6cD1eR5tY0uI8o",
        "card 4242 4242 4242 4242",
      ].join("\n"),
    );
    for (const leaked of ["sk-proj", "AIzaSy", "ghp_", "eyJhbGci", "Tr0ub4dor", "abc123def456", "a8F3kL9q", "4242 4242"]) {
      expect(masked).not.toContain(leaked);
    }
    expect(masked.split(HELPER_MASK).length).toBeGreaterThan(7);
  });

  it("leaves ordinary text, record ids and words alone", () => {
    const text =
      "The token count is high. Password strength: good. Record 3f2a1b4c-1111-4222-8333-444455556666. " +
      "Order 12345 cost 199 NOK. internationalization-and-localization-settings-page";
    expect(maskSecretLikeText(text)).toBe(text);
  });
});

describe("helper shapes", () => {
  it("caps text with a note", () => {
    const { text, truncated } = capHelperText("x".repeat(100), 50);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(capHelperText("short", 50)).toEqual({ text: "short", truncated: false });
  });

  it("refuses unknown fields such as tools", () => {
    expect(helperAskSchema.safeParse({ message: "hi", tools: [] }).success).toBe(false);
    expect(helperAskSchema.safeParse({ message: "hi" }).success).toBe(true);
  });
});
