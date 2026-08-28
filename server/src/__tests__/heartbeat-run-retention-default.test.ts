import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunRetentionEnabled } from "../config.js";

describe("heartbeat run retention default (DUR-366)", () => {
  it("defaults to disabled when the env var is unset", () => {
    expect(resolveHeartbeatRunRetentionEnabled({})).toBe(false);
  });

  it("stays disabled for any value other than the literal string \"true\"", () => {
    expect(resolveHeartbeatRunRetentionEnabled({ PAPERCLIP_HEARTBEAT_RUN_RETENTION_ENABLED: "false" })).toBe(false);
    expect(resolveHeartbeatRunRetentionEnabled({ PAPERCLIP_HEARTBEAT_RUN_RETENTION_ENABLED: "1" })).toBe(false);
    expect(resolveHeartbeatRunRetentionEnabled({ PAPERCLIP_HEARTBEAT_RUN_RETENTION_ENABLED: "" })).toBe(false);
  });

  it("enables only with an explicit \"true\"", () => {
    expect(resolveHeartbeatRunRetentionEnabled({ PAPERCLIP_HEARTBEAT_RUN_RETENTION_ENABLED: "true" })).toBe(true);
  });
});
