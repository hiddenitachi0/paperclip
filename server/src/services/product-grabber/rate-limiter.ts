/**
 * DUR-4187: a per-host minimum-interval rate limiter for the product
 * grabber's fetch path, so a staging run never hammers one vendor host even
 * across concurrent extraction calls.
 *
 * Deliberately process-local (an in-memory map, not a DB-backed lease like
 * `watchers.check_lease_until`): the only caller of this limiter is this
 * server's own product-grabber service, triggered by a board actor one URL
 * at a time, not a distributed scheduler fan-out -- a single process's
 * memory is enough to serialize per-host waits for that access pattern. If
 * this ever gains a second caller (e.g. a scheduled bulk re-scrape), revisit
 * with a DB lease the same way watchers claims a check.
 */
export class PerHostRateLimiter {
  private nextAllowedAt = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Resolves once it is this call's turn for `host`, waiting out the host's minimum interval if needed. */
  async waitForTurn(host: string): Promise<void> {
    const previous = this.queues.get(host) ?? Promise.resolve();
    const turn = previous.then(async () => {
      const waitMs = Math.max(0, (this.nextAllowedAt.get(host) ?? 0) - Date.now());
      if (waitMs > 0) await this.sleepImpl(waitMs);
      this.nextAllowedAt.set(host, Date.now() + this.minIntervalMs);
    });
    // Swallow rejection on the queue chain itself so one failed caller never
    // wedges every later caller waiting on the same host's queue.
    this.queues.set(host, turn.catch(() => {}));
    return turn;
  }
}
