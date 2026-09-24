/** Provider throttled us (HTTP 429). The run should pause, not fail. */
export class RateLimitedError extends Error {
  override name = "RateLimitedError";
  constructor(
    readonly provider: string,
    readonly retryAfterMs: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** A failure where trying the next model in the fallback chain makes sense. */
export class ProviderUnavailableError extends Error {
  override name = "ProviderUnavailableError";
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

interface HttpishError {
  status?: number;
  headers?: Headers | Record<string, string | null | undefined>;
  message?: string;
}

function header(err: HttpishError, name: string): string | null | undefined {
  const h = err.headers;
  if (!h) return undefined;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  return (h as Record<string, string | null | undefined>)[name];
}

/** Maps an SDK/HTTP error into Kira's error vocabulary. Unknown errors pass through. */
export function classifyProviderError(provider: string, err: unknown): unknown {
  const e = err as HttpishError;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = e?.message ?? String(err);
  if (status === 429) {
    const retryAfter = Number(header(e, "retry-after"));
    return new RateLimitedError(provider, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined, message);
  }
  if (status !== undefined && (status >= 500 || status === 404 || status === 408)) {
    return new ProviderUnavailableError(provider, status, message);
  }
  if (err instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|Connection error/i.test(err.message)) {
    return new ProviderUnavailableError(provider, undefined, message);
  }
  return err;
}
