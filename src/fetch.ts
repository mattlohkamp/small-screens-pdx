// Shared fetch with per-request timeout + retry/backoff.
// Scrapers and TMDB enrichment hit flaky third-party sites; a single
// slow/unreachable host should retry, not abort the whole pipeline.

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

export interface FetchRetryOptions {
  label?: string;
  // When false, a non-2xx response is returned as-is instead of throwing/retrying.
  // Use for endpoints where 4xx is a meaningful "no data" answer, not a transient fault.
  throwOnHttpError?: boolean;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const { label = "fetch", throwOnHttpError = true } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (throwOnHttpError && !res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return res;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      const delay = attempt * 2000;
      console.warn(`  ${label} failed (attempt ${attempt}), retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function fetchText(url: string, init: RequestInit = {}, label = "fetch"): Promise<string> {
  return (await fetchWithRetry(url, init, { label })).text();
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, label = "fetch"): Promise<T> {
  return (await fetchWithRetry(url, init, { label })).json() as Promise<T>;
}
