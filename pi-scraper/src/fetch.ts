// Shared fetch with per-request timeout + retry/backoff.
// Scrapers and TMDB enrichment hit flaky third-party sites; a single
// slow/unreachable host should retry, not abort the whole pipeline.

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

export interface FetchRetryOptions {
  label?: string;
  // When false, a non-2xx response is returned as-is instead of throwing.
  // Use for endpoints where 4xx is a meaningful "no data" answer, not a transient fault.
  throwOnHttpError?: boolean;
  // Non-2xx statuses to retry before giving up, even when throwOnHttpError is false.
  // Defaults to transient server/throttle codes. OMSI's CloudFront WAF intermittently
  // serves 403 for valid resources, so that scraper opts 403 in explicitly.
  retryStatuses?: number[];
}

const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const { label = "fetch", throwOnHttpError = true, retryStatuses = DEFAULT_RETRY_STATUSES } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      // throwOnHttpError path throws into the catch below, which retries on every attempt.
      if (throwOnHttpError && !res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      // Non-throwing callers still retry transient statuses (e.g. CloudFront 403/429/5xx)
      // rather than skip a valid resource on a flaky response.
      if (!res.ok && retryStatuses.includes(res.status) && attempt < MAX_ATTEMPTS) {
        const delay = attempt * 2000;
        console.warn(`  ${label} HTTP ${res.status} (attempt ${attempt}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      const delay = attempt * 2000;
      console.warn(`  ${label} failed (attempt ${attempt}), retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Retry an arbitrary async task with the same backoff policy as fetchWithRetry.
// Used to wrap whole scrapers (incl. Playwright/curl ones whose internals don't
// self-retry) so a transient failure retries a few times before giving up. Each
// attempt re-runs `fn` from scratch, so `fn` must be safe to repeat.
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { label?: string; attempts?: number } = {}
): Promise<T> {
  const { label = "task", attempts = MAX_ATTEMPTS } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const delay = attempt * 2000;
        console.warn(`  ${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// Bound a promise's wall-clock time. Backstop for tasks that don't honor their
// own timeout (e.g. a Playwright wait chain), so one hung scraper can't stall the
// whole run. The underlying work may keep running after rejection; callers clean
// up separately (e.g. closeBrowser after all scrapers settle).
export function withTimeout<T>(p: Promise<T>, ms: number, label = "task"): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

export async function fetchText(url: string, init: RequestInit = {}, label = "fetch"): Promise<string> {
  return (await fetchWithRetry(url, init, { label })).text();
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, label = "fetch"): Promise<T> {
  return (await fetchWithRetry(url, init, { label })).json() as Promise<T>;
}
