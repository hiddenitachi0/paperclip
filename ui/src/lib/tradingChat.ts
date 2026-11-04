import type { Approval, IssueComment } from "@paperclipai/shared";
import type { TradingVersionSummary } from "../api/trading";

/**
 * The strategy chat is a conversation with the company's Trader. The first
 * question opens a task for the Trader; every later message is a comment on
 * that task, and the Trader answers in the same thread. Pure helpers only,
 * so the words and the ordering can be tested without a browser.
 */

export interface ChatMessage {
  id: string;
  from: "you" | "trader";
  text: string;
  at: string;
}

const STORAGE_PREFIX = "paperclip.trading-chat";

function storageKey(companyId: string, strategyId: string): string {
  return `${STORAGE_PREFIX}.${companyId}.${strategyId}`;
}

/** The task this browser last used to talk about the strategy, if any. Storage can be blocked, so every access is guarded. */
export function readSavedChatThread(companyId: string, strategyId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(storageKey(companyId, strategyId)) ?? null;
  } catch {
    return null;
  }
}

export function saveChatThread(companyId: string, strategyId: string, issueId: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(companyId, strategyId), issueId);
  } catch {
    // The chat still works for this visit; it just will not be remembered.
  }
}

export function forgetChatThread(companyId: string, strategyId: string): void {
  try {
    globalThis.localStorage?.removeItem(storageKey(companyId, strategyId));
  } catch {
    // Nothing to forget.
  }
}

/**
 * The first message is stored as the task's description, wrapped in a
 * "Strategy: ..." line at the top and a how-to line at the bottom that are
 * for the Trader, not for the person. Show only the person's own words.
 */
export function firstQuestionFromTask(task: { title: string; description: string | null }): string {
  const description = task.description?.trim() ?? "";
  if (description) {
    const parts = description.split(/\n\n/);
    const withoutStrategy = parts[0]?.startsWith("Strategy: ") ? parts.slice(1) : parts;
    const withoutHowTo =
      withoutStrategy.length > 1 && withoutStrategy[withoutStrategy.length - 1]?.startsWith("You can read a strategy with")
        ? withoutStrategy.slice(0, -1)
        : withoutStrategy;
    const text = withoutHowTo.join("\n\n").trim();
    if (text) return text;
  }
  return task.title.replace(/^Trading question:\s*/, "").trim();
}

/** The whole conversation, oldest first: your first question, then each reply or follow-up. */
export function buildChatMessages(
  task: { id: string; title: string; description: string | null; createdAt: Date | string },
  comments: IssueComment[],
): ChatMessage[] {
  const first: ChatMessage = {
    id: `${task.id}:first`,
    from: "you",
    text: firstQuestionFromTask(task),
    at: new Date(task.createdAt).toISOString(),
  };
  const rest = comments
    .filter((c) => !c.deletedAt && c.body.trim().length > 0 && (c.authorType === "agent" || c.authorType === "user"))
    .map((c): ChatMessage => ({
      id: c.id,
      from: c.authorType === "agent" ? "trader" : "you",
      text: c.body,
      at: new Date(c.createdAt).toISOString(),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return [first, ...rest];
}

/** True while the last thing in the thread is yours, so the Trader still owes an answer. */
export function waitingForTrader(messages: ChatMessage[]): boolean {
  return messages.length > 0 && messages[messages.length - 1]!.from === "you";
}

/** The Trader's own reason for a draft, kept on the draft's approval card. */
export function traderNoteFromApproval(approval: Pick<Approval, "payload"> | null | undefined): { summary: string; reasons: string } | null {
  const note = (approval?.payload as { proposerNote?: unknown } | undefined)?.proposerNote;
  if (!note || typeof note !== "object") return null;
  const { summary, reasons } = note as { summary?: unknown; reasons?: unknown };
  if (typeof summary !== "string" || typeof reasons !== "string") return null;
  const s = summary.trim();
  const r = reasons.trim();
  return s || r ? { summary: s, reasons: r } : null;
}

/** Drafts the Trader saved that are still waiting for a person, newest first. */
export function traderDraftsWaiting(versions: TradingVersionSummary[]): TradingVersionSummary[] {
  return versions
    .filter((v) => v.status === "draft" && v.proposedByType === "agent")
    .sort((a, b) => b.version - a.version);
}
