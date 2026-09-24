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
  if (err instanceof Error && isNetworkFailure(err)) {
    return new ProviderUnavailableError(provider, undefined, message);
  }
  // Capacity errors sent inside a stream arrive with no HTTP status ("Service temporarily overloaded").
  if (status === undefined && OVERLOADED.test(message)) {
    return new ProviderUnavailableError(provider, undefined, message);
  }
  return err;
}

const OVERLOADED = /overloaded|out of capacity|not enough capacity|temporarily unavailable|service unavailable|try again later|server (is )?busy/i;

const NETWORK_MESSAGE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|fetch failed|Connection error|terminated|socket hang up|other side closed|premature close/i;
const NETWORK_CODE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|UND_ERR_\w+)$/;

/** Connection-level failures, including a stream cut off mid-response (undici: "terminated", cause UND_ERR_SOCKET). */
function isNetworkFailure(err: Error): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (NETWORK_MESSAGE.test(e.message) || (typeof code === "string" && NETWORK_CODE.test(code))) return true;
  }
  return false;
}
