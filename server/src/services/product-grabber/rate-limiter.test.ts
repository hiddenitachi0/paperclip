import { describe, expect, it, vi } from "vitest";
import { PerHostRateLimiter } from "./rate-limiter.js";

describe("PerHostRateLimiter", () => {
  it("does not delay the first call for a host", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const limiter = new PerHostRateLimiter(1000, sleep);
    await limiter.waitForTurn("example.com");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("serializes calls to the same host and waits out the minimum interval", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const limiter = new PerHostRateLimiter(1000, sleep);
    await limiter.waitForTurn("example.com");
    await limiter.waitForTurn("example.com");
    await limiter.waitForTurn("example.com");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("tracks different hosts independently", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const limiter = new PerHostRateLimiter(1000, sleep);
    await limiter.waitForTurn("a.example.com");
    await limiter.waitForTurn("b.example.com");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not let overlapping concurrent calls bypass serialization", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const limiter = new PerHostRateLimiter(1000, sleep);
    await Promise.all([
      limiter.waitForTurn("example.com"),
      limiter.waitForTurn("example.com"),
      limiter.waitForTurn("example.com"),
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
