/**
 * The message to show for a caught error. A failed plugin action reaches the
 * panel as a plain `{ code, message }` object rather than an `Error`, so read
 * `message` from that too instead of printing "[object Object]".
 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}
