import { ApiError } from "../api/client";

export const AGENT_AVATAR_HINT =
  "Upload a picture — PNG, JPEG, WEBP, GIF or SVG, up to 2 MB. Big photos are shrunk automatically. If you don't upload one, the agent's symbol is shown instead.";

const GENERIC_AVATAR_ERROR = "That picture couldn't be saved. Try a different file.";

function serverMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === "string") return value.toLowerCase();
  }
  return "";
}

/**
 * Maps every non-2xx avatar upload/remove response to one of a fixed set of
 * plain sentences. Never render `error.message` or the raw API body directly —
 * the server's text (e.g. "Unsupported image type: application/pdf") is
 * developer-facing and must not reach Filip.
 */
export function describeAgentAvatarError(error: unknown): string {
  if (!(error instanceof ApiError)) return GENERIC_AVATAR_ERROR;

  if (error.status === 403) {
    return "You don't have permission to change this agent's picture.";
  }
  if (error.status === 404) {
    return "This agent couldn't be found. Refresh the page and try again.";
  }
  if (error.status === 422) {
    const message = serverMessage(error.body);
    if (message.includes("exceeds")) {
      return "That picture is too big. Please use one under 2 MB.";
    }
    if (message.includes("svg")) {
      return "That picture couldn't be used. Please try a different file.";
    }
    if (message.includes("type") || message.includes("unsupported")) {
      return "That file type isn't supported. Please use a PNG, JPEG, WEBP, GIF or SVG picture.";
    }
  }
  return GENERIC_AVATAR_ERROR;
}
