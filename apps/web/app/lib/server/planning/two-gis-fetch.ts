type RetryOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  attempts?: number;
  retryDelayMs?: number;
};

/** Retries idempotent 2GIS calculations on transient network and service errors. */
export async function fetchTwoGis(
  endpoint: URL,
  init: Omit<RequestInit, "signal">,
  options: RetryOptions,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 2);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const response = await fetcher(endpoint, {
        ...init,
        signal: combineSignals(options.signal, options.timeoutMs),
      });
      if (!isTransientStatus(response.status) || attempt === attempts) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === attempts) throw error;
    }
    await delay((options.retryDelayMs ?? 300) * attempt, options.signal);
  }

  throw lastError;
}

function isTransientStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
