// Local-dev enrichment cache. CI never persists it (data/ is gitignored and not
// in any Actions cache), so production runs always enrich from scratch and can't
// serve stale TMDB/OMDb data. Locally, entries expire after CACHE_TTL_DAYS so
// ratings and metadata get refreshed without needing --force.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Film } from "./types.js";

const CACHE_PATH = "data/enrichment-cache.json";

// OMDb ratings move most (a new release's RT score settles over its first weeks);
// a week keeps local data close to what CI would produce.
export const CACHE_TTL_DAYS = 7;

export interface CacheEntry {
  cached_at: string; // ISO timestamp of the enrichment
  // Enriched film minus showtimes (those always come from the current scrape).
  film: Omit<Film, "showtimes">;
  // event_note found while matching (fallback matches only) — it lives on each
  // showtime, so it has to be re-applied to fresh showtimes on a cache hit.
  event_note: string | null;
}

export type EnrichmentCache = Record<string, CacheEntry>; // keyed by venue title

export function loadCache(): EnrichmentCache {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
  // Drop expired entries, and pre-TTL entries (plain Film records, no cached_at).
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86_400_000;
  const cache: EnrichmentCache = {};
  for (const [title, entry] of Object.entries(raw)) {
    const e = entry as Partial<CacheEntry>;
    if (e?.cached_at && e.film && Date.parse(e.cached_at) >= cutoff) cache[title] = e as CacheEntry;
  }
  return cache;
}

export function saveCache(cache: EnrichmentCache): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function toCacheEntry(film: Film): CacheEntry {
  const { showtimes, ...rest } = film;
  return {
    cached_at: new Date().toISOString(),
    film: rest,
    event_note: showtimes.find((s) => s.event_note)?.event_note ?? null,
  };
}

export function fromCacheEntry(entry: CacheEntry, showtimes: Film["showtimes"]): Film {
  return {
    ...entry.film,
    showtimes: entry.event_note ? showtimes.map((s) => ({ ...s, event_note: entry.event_note })) : showtimes,
  };
}
