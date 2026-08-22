import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { AGENT_AVATAR_HINT, describeAgentAvatarError } from "./agent-avatar-errors";

// Grep test: none of the operator-visible avatar copy may leak internal
// implementation details — field names, MIME types, or ticket numbers.
const FORBIDDEN = [/avatarAssetId/i, /\basset\b/i, /\bMIME\b/i, /\b(DUR|PAP)-\d+\b/i];

function assertPlainLanguage(text: string) {
  for (const pattern of FORBIDDEN) {
    expect(text).not.toMatch(pattern);
  }
}

describe("agent avatar operator-facing copy", () => {
  it("hint text is plain language", () => {
    assertPlainLanguage(AGENT_AVATAR_HINT);
    expect(AGENT_AVATAR_HINT).toBe(
      "Upload a picture — PNG, JPEG, WEBP, GIF or SVG, up to 2 MB. Big photos are shrunk automatically. If you don't upload one, the agent's symbol is shown instead.",
    );
  });

  it("maps a 403 to a plain permission sentence", () => {
    const message = describeAgentAvatarError(
      new ApiError("Agents cannot set their own avatar", 403, { error: "Agents cannot set their own avatar" }),
    );
    assertPlainLanguage(message);
    expect(message).toBe("You don't have permission to change this agent's picture.");
  });

  it("maps a 404 (agent not found / wrong company) to a plain sentence", () => {
    const message = describeAgentAvatarError(new ApiError("Agent not found", 404, { error: "Agent not found" }));
    assertPlainLanguage(message);
  });

  it("maps an oversize 422 to the 2 MB sentence without echoing the byte count", () => {
    const message = describeAgentAvatarError(
      new ApiError("x", 422, { error: "Image exceeds 2000000 bytes" }),
    );
    assertPlainLanguage(message);
    expect(message).toContain("2 MB");
    expect(message).not.toContain("2000000");
  });

  it("maps an unsupported-type 422 to the format list without echoing the content type", () => {
    const message = describeAgentAvatarError(
      new ApiError("x", 422, { error: "Unsupported image type: application/pdf" }),
    );
    assertPlainLanguage(message);
    expect(message).not.toContain("application/pdf");
  });

  it("maps a bad-SVG 422 to a plain sentence", () => {
    const message = describeAgentAvatarError(new ApiError("x", 422, { error: "SVG could not be sanitized" }));
    assertPlainLanguage(message);
  });

  it("falls back to the catch-all sentence for unrecognized errors", () => {
    expect(describeAgentAvatarError(new Error("network down"))).toBe(
      "That picture couldn't be saved. Try a different file.",
    );
    expect(
      describeAgentAvatarError(new ApiError("x", 400, { error: "Missing file field 'file'" })),
    ).toBe("That picture couldn't be saved. Try a different file.");
  });
});
