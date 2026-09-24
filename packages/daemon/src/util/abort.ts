/** Error thrown when an operation is cancelled through an AbortSignal. */
export class AbortedError extends Error {
  override name = "AbortedError";
  constructor(reason?: unknown) {
    super(typeof reason === "string" ? reason : "Operation aborted");
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError(signal.reason);
}

/** setTimeout as a promise that rejects immediately when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError(signal.reason));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof AbortedError ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError"))
  );
}
