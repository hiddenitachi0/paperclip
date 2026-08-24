import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstanceStartLock } from "../services/instance-start-lock.ts";

describe("heartbeat instance start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives independent instances independent locks", async () => {
    const a = createInstanceStartLock();
    const b = createInstanceStartLock();

    let releaseA!: () => void;
    const aBlocked = a.withInstanceStartLock(
      () => new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
    );
    await Promise.resolve();

    // A held lock in instance `a` must not block instance `b` -- this is the
    // whole point of the factory over a bare module-level singleton.
    const bResult = await b.withInstanceStartLock(async () => "b started");
    expect(bResult).toBe("b started");

    releaseA();
    await aBlocked;
  });

  it("serializes concurrent claim attempts from different agents, then releases", async () => {
    const { withInstanceStartLock } = createInstanceStartLock();
    let releaseFirst!: () => void;
    const firstStart = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const secondStart = vi.fn(async () => "started");

    void withInstanceStartLock(firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withInstanceStartLock(secondStart);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    releaseFirst();
    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale instance start lock freeze later queued-run starts", async () => {
    vi.useFakeTimers();
    const { withInstanceStartLock } = createInstanceStartLock();

    const firstStart = vi.fn(() => new Promise<void>(() => undefined));
    const secondStart = vi.fn(async () => "started");

    void withInstanceStartLock(firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withInstanceStartLock(secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });
});
