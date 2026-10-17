import { describe, expect, it } from "vitest";
import {
  HELPER_MASK,
  HELPER_WANTS_CHANGE_MARKER,
  capHelperText,
  helperAskSchema,
  helperQuestionAsksForChange,
  maskSecretLikeText,
  stripChangeRequestMarker,
} from "./helper.js";

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

describe("helperQuestionAsksForChange", () => {
  it.each([
    "Hire a marketing agent",
    "Can you create a task for Maja to fix the login page?",
    "Please change the budget to 50 dollars",
    "could you please assign this to the CEO",
    "I want you to delete this project",
    "I'd like to set up a daily job that sends the sales report",
    "Set up a weekly routine for the finance agent",
    "Turn off the heartbeat for this agent.",
    "ok, can you pause all agents",
    "Make a new agent called Ola",
    "This looks wrong. Rename it to Sales report.",
    "Let's approve this card",
    "Kan du opprette en oppgave til Maja?",
    "Ansett en ny regnskapsagent",
    "Endre budsjettet til 100",
  ])("treats %j as a request to change something", (question) => {
    expect(helperQuestionAsksForChange(question)).toBe(true);
  });

  it.each([
    "What does this setting do?",
    "How do I hire an agent?",
    "Should I approve this?",
    "Why is this agent paused?",
    "Explain this page",
    "Write a short description for this agent",
    "Can I delete this project safely?",
    "Is the budget too low?",
    "Tell me what the heartbeat interval means",
    "Give me the steps to change the model",
    "Hva betyr denne innstillingen?",
    "Hvordan endrer jeg budsjettet?",
    "",
    "The settings page looks empty",
  ])("treats %j as a question, not a change", (question) => {
    expect(helperQuestionAsksForChange(question)).toBe(false);
  });
});

describe("stripChangeRequestMarker", () => {
  it("removes the marker and reports it", () => {
    expect(stripChangeRequestMarker(`Here is how.\n\n${HELPER_WANTS_CHANGE_MARKER}`)).toEqual({ text: "Here is how.", wantsChange: true });
    expect(stripChangeRequestMarker("Here is how. [[ want_change ]]").wantsChange).toBe(true);
  });

  it("leaves an answer without the marker alone", () => {
    expect(stripChangeRequestMarker("Just an answer")).toEqual({ text: "Just an answer", wantsChange: false });
  });
});
