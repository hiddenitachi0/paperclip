import { describe, expect, it } from "vitest";
import type { IssueComment } from "@paperclipai/shared";
import type { TradingVersionSummary } from "../api/trading";
import { buildChatMessages, firstQuestionFromTask, traderDraftsWaiting, traderNoteFromApproval, waitingForTrader } from "./tradingChat";

const comment = (over: Partial<IssueComment>): IssueComment =>
  ({ id: "c", body: "hi", authorType: "agent", createdAt: new Date("2026-11-04T10:00:00Z"), deletedAt: null, ...over }) as IssueComment;

describe("firstQuestionFromTask", () => {
  it("drops the lines written for the Trader and keeps the person's own words", () => {
    const description = "Strategy: Trend (BTC, id abc)\n\nWhy did it buy yesterday?\n\nYou can read a strategy with trading_get_strategy and propose a rule change.";
    expect(firstQuestionFromTask({ title: "Trading question: Why did it buy", description })).toBe("Why did it buy yesterday?");
  });
  it("keeps a multi-paragraph question whole", () => {
    const description = "Strategy: Trend (BTC, id abc)\n\nLine one.\n\nLine two.\n\nYou can read a strategy with x";
    expect(firstQuestionFromTask({ title: "t", description })).toBe("Line one.\n\nLine two.");
  });
  it("falls back to the title without its prefix", () => {
    expect(firstQuestionFromTask({ title: "Trading question: Stay out when wild", description: null })).toBe("Stay out when wild");
  });
});

describe("buildChatMessages", () => {
  const task = { id: "t1", title: "Trading question: q", description: "Hello there", createdAt: "2026-11-04T09:00:00Z" };
  it("puts the first question first, then replies in time order, skipping deleted and system notes", () => {
    const msgs = buildChatMessages(task, [
      comment({ id: "b", body: "Later", authorType: "user", createdAt: new Date("2026-11-04T11:00:00Z") }),
      comment({ id: "a", body: "Answer", authorType: "agent", createdAt: new Date("2026-11-04T10:00:00Z") }),
      comment({ id: "x", body: "gone", deletedAt: new Date() }),
      comment({ id: "s", body: "status change", authorType: "system" as never }),
    ]);
    expect(msgs.map((m) => [m.from, m.text])).toEqual([
      ["you", "Hello there"],
      ["trader", "Answer"],
      ["you", "Later"],
    ]);
    expect(waitingForTrader(msgs)).toBe(true);
    expect(waitingForTrader(msgs.slice(0, 2))).toBe(false);
  });
});

describe("traderNoteFromApproval", () => {
  it("reads the Trader's reason from the card", () => {
    expect(traderNoteFromApproval({ payload: { proposerNote: { summary: " Tighter stop ", reasons: "Too many misses" } } })).toEqual({ summary: "Tighter stop", reasons: "Too many misses" });
  });
  it("returns null when there is no reason", () => {
    expect(traderNoteFromApproval({ payload: {} })).toBeNull();
    expect(traderNoteFromApproval({ payload: { proposerNote: { summary: 3 } } })).toBeNull();
    expect(traderNoteFromApproval(undefined)).toBeNull();
  });
});

describe("traderDraftsWaiting", () => {
  const v = (n: number, status: TradingVersionSummary["status"], by: TradingVersionSummary["proposedByType"]) => ({ id: `v${n}`, version: n, status, proposedByType: by }) as TradingVersionSummary;
  it("keeps only the Trader's drafts that nobody has answered, newest first", () => {
    const out = traderDraftsWaiting([v(1, "approved", "user"), v(2, "draft", "user"), v(3, "draft", "agent"), v(4, "draft", "agent"), v(5, "superseded", "agent")]);
    expect(out.map((x) => x.version)).toEqual([4, 3]);
  });
});
