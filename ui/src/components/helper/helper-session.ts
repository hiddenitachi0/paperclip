import {
  HELPER_HISTORY_MAX_TURNS,
  HELPER_HISTORY_TURN_MAX_CHARS,
  capHelperText,
  type HelperAskResponse,
  type HelperPictureInput,
} from "@paperclipai/shared";

/**
 * The Ask panel's conversation, per signed-in person and company, for this
 * browser tab.
 *
 * It lives in sessionStorage so it survives moving between pages and a
 * reload, and is gone when the tab is closed. Nothing of it is kept on the
 * server. The key carries the user id, so someone else signing in on the same
 * tab never sees (or sends as history) another person's questions, answers or
 * captured page text; signing out removes all of it (clearHelperSessions,
 * called from authApi.signOut). With no known user nothing is read or written. Uploaded pictures are not kept (only their names); a picture
 * picked from the company's Files is kept by reference.
 */

export interface HelperTurnPicture {
  key: string;
  name: string;
  /** Empty when the preview was not kept (an upload, after a reload). */
  previewUrl: string;
}

export interface HelperTurn {
  role: "user" | "assistant" | "investigation";
  content: string;
  meta?: Pick<HelperAskResponse, "modelLabel" | "costCents" | "truncated">;
  /** Fields the person marked when asking this question. */
  applyTargets?: string[];
  /** Pictures attached to this question (previews only; not sent again with later questions). */
  pictures?: HelperTurnPicture[];
  /** What was sent with this question, so "Investigate deeper" can hand the same to an agent. */
  context?: string | null;
  pageRoute?: string | null;
  references?: string[];
  pictureInputs?: HelperPictureInput[];
  /** The quick model said this needs a closer look (Phase 3). */
  suggestInvestigation?: boolean;
  /** The question asked Paperclip to make a change: the panel offers "Do this in Board chat". */
  suggestBoardChat?: boolean;
  /** role "user": the page's title when it was asked (names the records on it), for the Board chat hand-off. */
  pageTitle?: string | null;
  /** role "investigation": the task that was started from this conversation. */
  investigationId?: string;
  investigationIdentifier?: string | null;
  agentName?: string | null;
}

export interface HelperSession {
  turns: HelperTurn[];
  /** The model picked in the panel ("" = the company's default). */
  entryId: string;
  /** Investigations from this conversation whose answer the person has seen. */
  seenAnswerIds: string[];
}

const SESSION_PREFIX = "paperclip.helper.session.v1:";
const OPEN_KEY = "paperclip.helper.open.v1";
const WIDTH_KEY = "paperclip.helper.width.v1";
/** Old turns beyond this are dropped from storage (the server only reads the last few anyway). */
const STORED_TURNS_MAX = 60;

function storage(kind: "session" | "local"): Storage | null {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function emptySession(): HelperSession {
  return { turns: [], entryId: "", seenAnswerIds: [] };
}

function sessionKey(userId: string, companyId: string): string {
  return `${SESSION_PREFIX}${userId}:${companyId}`;
}

export function loadHelperSession(userId: string | null, companyId: string): HelperSession {
  if (!userId) return emptySession();
  try {
    const raw = storage("session")?.getItem(sessionKey(userId, companyId));
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as Partial<HelperSession>;
    return {
      turns: Array.isArray(parsed.turns) ? parsed.turns.filter((t) => t && typeof t.content === "string") : [],
      entryId: typeof parsed.entryId === "string" ? parsed.entryId : "",
      seenAnswerIds: Array.isArray(parsed.seenAnswerIds) ? parsed.seenAnswerIds.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return emptySession();
  }
}

/** What is kept of a turn: no picture bytes. */
function storableTurn(turn: HelperTurn): HelperTurn {
  const pictures = turn.pictures?.map((p) => ({ ...p, previewUrl: p.previewUrl.startsWith("data:") ? "" : p.previewUrl }));
  const pictureInputs = turn.pictureInputs?.filter((p) => p.kind === "file");
  return {
    ...turn,
    ...(pictures ? { pictures } : {}),
    ...(turn.pictureInputs ? { pictureInputs } : {}),
  };
}

export function saveHelperSession(userId: string | null, companyId: string, session: HelperSession): void {
  if (!userId) return;
  const store = storage("session");
  if (!store) return;
  const key = sessionKey(userId, companyId);
  try {
    if (session.turns.length === 0 && !session.entryId) {
      store.removeItem(key);
      return;
    }
    const value: HelperSession = {
      turns: session.turns.slice(-STORED_TURNS_MAX).map(storableTurn),
      entryId: session.entryId,
      seenAnswerIds: session.seenAnswerIds.slice(-100),
    };
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the conversation still works, it just will not survive a reload.
  }
}

/** Sign-out: forget every saved Ask conversation in this tab (all people, all companies) and the open panel. */
export function clearHelperSessions(): void {
  const store = storage("session");
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(SESSION_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
    store.removeItem(OPEN_KEY);
  } catch {
    // ignore
  }
}

export function loadHelperOpen(): boolean {
  try {
    return storage("session")?.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHelperOpen(open: boolean): void {
  try {
    if (open) storage("session")?.setItem(OPEN_KEY, "1");
    else storage("session")?.removeItem(OPEN_KEY);
  } catch {
    // ignore
  }
}

export const HELPER_PANEL_MIN_WIDTH = 340;
export const HELPER_PANEL_DEFAULT_WIDTH = 400;
export const HELPER_PANEL_MAX_WIDTH = 760;

export function clampHelperWidth(width: number, viewportWidth: number): number {
  const max = Math.max(HELPER_PANEL_MIN_WIDTH, Math.min(HELPER_PANEL_MAX_WIDTH, viewportWidth - 80));
  return Math.round(Math.min(max, Math.max(HELPER_PANEL_MIN_WIDTH, width)));
}

export function loadHelperWidth(): number {
  try {
    const n = Number(storage("local")?.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : HELPER_PANEL_DEFAULT_WIDTH;
  } catch {
    return HELPER_PANEL_DEFAULT_WIDTH;
  }
}

export function saveHelperWidth(width: number): void {
  try {
    storage("local")?.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}

/** History text for an earlier question that had pictures: the model knows they existed, they are not resent. */
export function historyContentOf(turn: Pick<HelperTurn, "content" | "pictures">): string {
  const n = turn.pictures?.length ?? 0;
  if (n === 0) return turn.content;
  return `${turn.content}\n\n[${n === 1 ? "1 picture was" : `${n} pictures were`} attached to this question; they are not sent again.]`;
}

/**
 * The history sent with a new question, within the server's limits: the last
 * HELPER_HISTORY_MAX_TURNS questions and answers, each cut to
 * HELPER_HISTORY_TURN_MAX_CHARS. An investigation's answer counts as an answer,
 * so a follow-up question can refer to it.
 */
export function buildHelperHistory(
  turns: readonly HelperTurn[],
  investigationAnswers: ReadonlyMap<string, string> = new Map(),
): Array<{ role: "user" | "assistant"; content: string }> {
  const items: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const turn of turns) {
    if (turn.role === "investigation") {
      const answer = turn.investigationId ? investigationAnswers.get(turn.investigationId) : undefined;
      if (answer) {
        items.push({ role: "assistant", content: `${turn.agentName ?? "The investigating agent"} looked into it and answered:\n\n${answer}` });
      }
      continue;
    }
    const content = historyContentOf(turn);
    if (!content.trim()) continue;
    items.push({ role: turn.role, content });
  }
  return items
    .slice(-HELPER_HISTORY_MAX_TURNS * 2)
    .map((item) => ({ ...item, content: capHelperText(item.content, HELPER_HISTORY_TURN_MAX_CHARS).text }));
}
