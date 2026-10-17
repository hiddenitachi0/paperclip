// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_HISTORY_MAX_TURNS, HELPER_HISTORY_TURN_MAX_CHARS } from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import { helperErrorText } from "./helper-errors";
import { buildHelperHistory, clampHelperWidth, clearHelperSessions, loadHelperSession, saveHelperSession, type HelperTurn } from "./helper-session";

afterEach(() => window.sessionStorage.clear());

describe("helper session", () => {
  it("keeps the conversation per company without picture bytes", () => {
    const turns: HelperTurn[] = [
      {
        role: "user",
        content: "What is in this?",
        pictures: [
          { key: "a", name: "shot.png", previewUrl: "data:image/png;base64,AAAA" },
          { key: "b", name: "logo.png", previewUrl: "/api/attachments/f1/content" },
        ],
        pictureInputs: [
          { kind: "upload", name: "shot.png", contentType: "image/png", dataBase64: "AAAA" },
          { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" },
        ],
      },
      { role: "assistant", content: "A logo." },
    ];
    saveHelperSession("u1", "c1", { turns, entryId: "m1", seenAnswerIds: [] });
    const back = loadHelperSession("u1", "c1");
    expect(back.entryId).toBe("m1");
    expect(back.turns[0]!.pictures!.map((p) => p.previewUrl)).toEqual(["", "/api/attachments/f1/content"]);
    expect(back.turns[0]!.pictureInputs).toEqual([{ kind: "file", fileId: "11111111-1111-4111-8111-111111111111" }]);
    expect(window.sessionStorage.getItem("paperclip.helper.session.v1:u1:c1")).not.toContain("AAAA");
    expect(loadHelperSession("u1", "c2").turns).toEqual([]);
    // Someone else on the same tab, or nobody known yet: nothing.
    expect(loadHelperSession("u2", "c1").turns).toEqual([]);
    expect(loadHelperSession(null, "c1").turns).toEqual([]);
  });

  it("does not save anything while nobody is known, and sign-out forgets every conversation and the open panel", () => {
    saveHelperSession(null, "c1", { turns: [{ role: "user", content: "secret page text" }], entryId: "", seenAnswerIds: [] });
    expect(window.sessionStorage.length).toBe(0);
    saveHelperSession("u1", "c1", { turns: [{ role: "user", content: "a" }], entryId: "", seenAnswerIds: [] });
    saveHelperSession("u1", "c2", { turns: [{ role: "user", content: "b" }], entryId: "", seenAnswerIds: [] });
    window.sessionStorage.setItem("paperclip.helper.session.v1:c9", "{}");
    window.sessionStorage.setItem("paperclip.helper.open.v1", "1");
    window.sessionStorage.setItem("unrelated", "keep");
    clearHelperSessions();
    expect(Object.keys(window.sessionStorage)).toEqual(["unrelated"]);
  });

  it("survives broken storage", () => {
    window.sessionStorage.setItem("paperclip.helper.session.v1:u1:c1", "{not json");
    expect(loadHelperSession("u1", "c1")).toEqual({ turns: [], entryId: "", seenAnswerIds: [] });
  });

  it("builds history within the server's limits, with investigation answers as answers", () => {
    const turns: HelperTurn[] = [];
    for (let i = 0; i < 30; i += 1) {
      turns.push({ role: "user", content: `q${i}` });
      turns.push({ role: "assistant", content: `a${i} ${"x".repeat(i === 29 ? 9_000 : 1)}` });
    }
    turns.push({ role: "investigation", content: "Dig in", investigationId: "i1", agentName: "Investigator" });
    turns.push({ role: "investigation", content: "Still going", investigationId: "i2" });
    const history = buildHelperHistory(turns, new Map([["i1", "The key expired."]]));
    expect(history).toHaveLength(HELPER_HISTORY_MAX_TURNS * 2);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "Investigator looked into it and answered:\n\nThe key expired." });
    expect(Math.max(...history.map((h) => h.content.length))).toBeLessThanOrEqual(HELPER_HISTORY_TURN_MAX_CHARS);
    expect(history.some((h) => h.content.includes("Still going"))).toBe(false);
  });

  it("keeps the panel width sensible on any screen", () => {
    expect(clampHelperWidth(2000, 1440)).toBe(760);
    expect(clampHelperWidth(100, 1440)).toBe(340);
    expect(clampHelperWidth(700, 600)).toBe(520);
  });
});

describe("helperErrorText", () => {
  it("keeps plain server messages and replaces bare ones", () => {
    expect(helperErrorText(new ApiError("OpenRouter is busy right now. Try again in a moment.", 429, {}))).toBe(
      "OpenRouter is busy right now. Try again in a moment.",
    );
    expect(helperErrorText(new ApiError("Request failed: 429", 429, null))).toBe("Too many requests right now. Wait a minute and try again.");
    expect(helperErrorText(new ApiError("Internal server error", 500, {}))).toBe(
      "The helper could not answer: something went wrong on Paperclip's side. Try again in a moment.",
    );
    expect(helperErrorText(new ApiError("Request failed: 504", 504, null))).toBe("The helper could not answer in time. Try again, or pick a faster model.");
    expect(helperErrorText(new ApiError("Request failed: 413", 413, null))).toContain("The pictures are too large together");
    expect(helperErrorText(new ApiError("Unauthorized", 401, {}))).toContain("You are signed out");
    expect(helperErrorText(new TypeError("Failed to fetch"))).toBe("Could not reach Paperclip. Check your connection and try again.");
    expect(helperErrorText(new ApiError("Forbidden", 403, {}), "save")).toBe("Only a company owner or admin can change these settings.");
    expect(helperErrorText("weird", "investigate")).toBe("The investigation could not start. Try again.");
  });
});
