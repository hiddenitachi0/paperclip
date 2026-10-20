import { z } from "zod";

/**
 * Board chat on signed-in Paperclip servers (approved by Filip, 20 Oct 2026).
 *
 * On a local single-user Paperclip, Board chat works exactly as before. On a
 * signed-in (shared) Paperclip it is only for a company's owner and admins
 * (and instance admins), each company switches it on separately (off by
 * default), and every change it wants to make is held as a card in the chat
 * until the person clicks Approve. Reading is free.
 */

/** How many Board chat messages a company may send per day when nobody has picked a number. */
export const BOARD_CHAT_DEFAULT_DAILY_MESSAGE_CAP = 40;
/** The highest daily message cap an owner can set. */
export const BOARD_CHAT_MAX_DAILY_MESSAGE_CAP = 500;
/** A held change that nobody approves within this many hours is dropped. */
export const BOARD_CHAT_ACTION_EXPIRES_AFTER_HOURS = 24;

export interface BoardChatSettings {
  companyId: string;
  enabled: boolean;
  dailyMessageCap: number;
  /** Messages sent in this company's Board chat since midnight (UTC). */
  messagesToday: number;
  enabledAt: string | null;
  enabledByUserId: string | null;
}

export const updateBoardChatSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    dailyMessageCap: z.number().int().min(1).max(BOARD_CHAT_MAX_DAILY_MESSAGE_CAP).optional(),
  })
  .strict();
export type UpdateBoardChatSettingsInput = z.infer<typeof updateBoardChatSettingsSchema>;

/**
 * Why Board chat cannot be used by this person in this company.
 *   instance_off   the Board chat switch for the whole Paperclip is off
 *   company_off    this company has not switched Board chat on
 *   not_allowed    the person is not an owner or admin of this company
 *   not_signed_in  nobody is signed in
 */
export const BOARD_CHAT_UNAVAILABLE_REASONS = [
  "instance_off",
  "company_off",
  "not_allowed",
  "not_signed_in",
] as const;
export type BoardChatUnavailableReasonCode = (typeof BOARD_CHAT_UNAVAILABLE_REASONS)[number];

export interface BoardChatAvailabilityResponse {
  available: boolean;
  reason: BoardChatUnavailableReasonCode | null;
  /** A plain sentence for the person when it is not available. */
  message: string | null;
  /** "local" on a single-user Paperclip (no approval cards), "signed_in" otherwise. */
  mode: "local" | "signed_in";
  /** True when this person may switch Board chat on or off for the company. */
  canChangeSettings: boolean;
  dailyMessageCap: number | null;
  messagesToday: number | null;
}

export const BOARD_CHAT_ACTION_STATUSES = [
  "pending",
  "executing",
  "done",
  "failed",
  "cancelled",
  "expired",
] as const;
export type BoardChatActionStatus = (typeof BOARD_CHAT_ACTION_STATUSES)[number];

export interface BoardChatActionDetail {
  label: string;
  value: string;
}

/** A change Board chat wants to make, shown as a card with Approve / Cancel. */
export interface BoardChatAction {
  id: string;
  companyId: string;
  issueId: string | null;
  runId: string | null;
  /** The person whose chat asked for it; only they can approve it. */
  userId: string;
  /** The exact change, in plain words. */
  summary: string;
  /** The exact values that will be sent, one line each. */
  details: BoardChatActionDetail[];
  status: BoardChatActionStatus;
  /** What happened after Approve, in plain words. */
  resultMessage: string | null;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

/** The SSE event the stream sends when the chat has prepared a change. */
export interface BoardChatActionEvent {
  type: "action";
  action: BoardChatAction;
}
