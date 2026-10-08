// Fetch helper for the Storylines editor (the /video-storylines REST routes)
// that always throws a PLAIN-ENGLISH Error -- never a raw JSON body or a bare
// "Internal server error". The server's own messages for expected problems
// (409/422/503 etc.) are already written for people, so they are shown as
// they are; everything else is mapped to a sentence that says what to do.
//
// Standalone on purpose: this UI bundle cannot import @paperclipai/shared.

export class StorylineRequestError extends Error {
  readonly status: number;
  /** Per-item problems (e.g. a script's "Scene 2, shot 3: ..." list) when the server sent them. */
  readonly problems: string[];
  constructor(message: string, status: number, problems: string[] = []) {
    super(message);
    this.name = "StorylineRequestError";
    this.status = status;
    this.problems = problems;
  }
}

type ZodIssueLike = { path?: unknown; message?: unknown };

const FIELD_NAMES: Record<string, string> = {
  title: "Title",
  prompt: "Shot description",
  cameraNotes: "Camera notes",
  durationSeconds: "Length (seconds)",
  budgetCapCents: "Budget cap",
  confirmBudgetCapCents: "Budget cap",
  orderIndex: "Position",
  sceneId: "Scene",
  providerId: "Video service",
  model: "Model",
  transitionIn: "Transition",
  notes: "Scene notes",
  script: "Script",
  mode: "Import mode",
};

function describeZodIssue(issue: ZodIssueLike): string | null {
  const path = Array.isArray(issue.path) ? issue.path.map(String) : [];
  const field = path.length > 0 ? FIELD_NAMES[path[path.length - 1]!] ?? path.join(".") : null;
  const message = typeof issue.message === "string" ? issue.message : null;
  if (!message) return null;
  return field ? `${field}: ${message}` : message;
}

/** Turns an HTTP failure from the storyline routes into one plain sentence (plus any per-item problems). */
export function friendlyStorylineError(status: number, bodyText: string, action?: string): StorylineRequestError {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  // A short plain-text body (not JSON, not an HTML error page from a proxy) is a message meant for people too.
  const plainText = !body && bodyText.trim() && bodyText.length < 500 && !bodyText.trim().startsWith("<") ? bodyText.trim() : null;
  const serverMessage = typeof body?.error === "string" ? body.error : plainText;
  const details = body?.details;
  const problems =
    details && typeof details === "object" && !Array.isArray(details) && Array.isArray((details as { errors?: unknown }).errors)
      ? ((details as { errors: unknown[] }).errors.filter((e) => typeof e === "string") as string[])
      : [];
  const doing = action ? ` while ${action}` : "";

  if (status === 413) {
    return new StorylineRequestError("That is too much to send in one go (over 10 MB). Split the script into smaller parts.", status);
  }
  if (status === 401) {
    return new StorylineRequestError("You are signed out. Sign in again and retry.", status);
  }
  if (status === 403) {
    return new StorylineRequestError(serverMessage && !/^forbidden$/i.test(serverMessage) ? `You don't have access to do that: ${serverMessage}` : "You don't have access to do that in this company.", status);
  }
  if (status === 400 && serverMessage === "Validation error" && Array.isArray(details)) {
    const lines = (details as ZodIssueLike[]).map(describeZodIssue).filter((l): l is string => !!l);
    if (lines.length === 0) return new StorylineRequestError("Some of what you entered is not valid. Please check the fields and try again.", status);
    return lines.length === 1
      ? new StorylineRequestError(`Please check: ${lines[0]}`, status)
      : new StorylineRequestError("Please check these fields:", status, lines);
  }
  if (status === 404) {
    return new StorylineRequestError(serverMessage ?? "That storyline, scene or shot no longer exists. Refresh the page.", status);
  }
  if (status === 502 || status === 503 || status === 504) {
    if (serverMessage) return new StorylineRequestError(serverMessage, status, problems);
    return new StorylineRequestError(`The server took too long or could not reach a service${doing}. Wait a moment and try again.`, status);
  }
  if (status >= 500 || serverMessage === "Internal server error") {
    return new StorylineRequestError(
      `Something went wrong on the server${doing}. Nothing you did caused it -- try again, and if it keeps happening, tell your admin (the server log has the details).`,
      status,
    );
  }
  if (serverMessage) return new StorylineRequestError(serverMessage, status, problems);
  return new StorylineRequestError(`The request failed${doing} (error ${status}). Try again.`, status);
}

/** Like the page's hostFetchJson, but failures are StorylineRequestErrors with plain messages. */
export async function storylineFetchJson<T>(path: string, init?: RequestInit, action?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  } catch {
    throw new StorylineRequestError("Could not reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) throw friendlyStorylineError(res.status, await res.text().catch(() => ""), action);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The message to show for any caught error (plain Errors pass through). */
export function errorText(e: unknown): string {
  if (e instanceof StorylineRequestError && e.problems.length > 0) {
    return `${e.message}\n${e.problems.map((p) => `- ${p}`).join("\n")}`;
  }
  return e instanceof Error ? e.message : String(e);
}
