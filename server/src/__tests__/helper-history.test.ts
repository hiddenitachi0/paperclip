import { describe, expect, it } from "vitest";
import { HELPER_HISTORY_MAX_TURNS, HELPER_HISTORY_TURN_MAX_CHARS, HELPER_MASK } from "@paperclipai/shared";
import { normalizeHelperHistory } from "../services/helper.ts";

/**
 * The ask route accepts a long conversation; the model only gets the last
 * HELPER_HISTORY_MAX_TURNS questions and answers, each cut and masked.
 */
describe("normalizeHelperHistory", () => {
  it("keeps the last turns only, cuts each one, masks keys and ends on an answer", () => {
    const history = Array.from({ length: 41 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: i === 39 ? `token: sk-abcdefgh12345678 ${"y".repeat(9_000)}` : `turn ${i}`,
    }));
    const out = normalizeHelperHistory(history);
    expect(out.length).toBeLessThanOrEqual(HELPER_HISTORY_MAX_TURNS * 2);
    expect(out[0]!.role).toBe("user");
    expect(out[out.length - 1]!.role).toBe("assistant");
    expect(out.some((t) => t.content === "turn 0")).toBe(false);
    const long = out.find((t) => t.content.includes(HELPER_MASK))!;
    expect(long.content).not.toContain("sk-abcdefgh12345678");
    expect(long.content.length).toBeLessThanOrEqual(HELPER_HISTORY_TURN_MAX_CHARS);
  });
});
