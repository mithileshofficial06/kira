import { sleep } from "../util/abort.js";

/**
 * Token-bucket limiter, one per provider. `acquire` waits for a slot and
 * rejects immediately if the signal aborts while waiting.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly refillPerMs: number;
  private pausedUntil = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = requestsPerMinute;
    this.lastRefill = now();
    this.refillPerMs = requestsPerMinute / 60_000;
  }

  /** Called after a 429 so every caller backs off, not just the one that got throttled. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** Milliseconds until a request may be sent (0 means now). Consumes nothing. */
  waitTime(): number {
    this.refill();
    const pause = Math.max(0, this.pausedUntil - this.now());
    const bucket = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    return Math.max(pause, bucket);
  }

  /** Takes a slot if one is free right now. */
  tryAcquire(): boolean {
    if (this.waitTime() > 0) return false;
    this.tokens -= 1;
    return true;
  }

  async acquire(signal: AbortSignal): Promise<void> {
    while (!this.tryAcquire()) {
      await sleep(this.waitTime(), signal);
    }
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.requestsPerMinute, this.tokens + (t - this.lastRefill) * this.refillPerMs);
    this.lastRefill = t;
  }
}
