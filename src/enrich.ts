import "dotenv/config";
import type { Film } from "./types.js";
import { fetchWithRetry } from "./fetch.js";

const TMDB_BASE = "https://api.themoviedb.org/3";

// Venue titles that are misspelled or too obscure to match via search.
// Key: exact title string from the venue site. Value: TMDB integer ID.
const TMDB_ID_OVERRIDES: Record<string, number> = {
  "964 Pinnochio": 50162,
  // CST title uses the original German title; TMDB has it as "Anita – Dances of Vice"
  "ANITA: DANCES OF VICE (1987)": 131338,
  // CST title uses the full English subtitle; TMDB canonical is slightly different
  "IT IS BETTER TO BE WEALTHY & HEALTHY THAN POOR & ILL (1992)": 259436,
  // Hollywood's event title references the film by tour/song name, not its
  // actual title: TMDB has it as "In the Beginning Was the End: The Truth About De-Evolution"
  "Devo 250: The Beginning Was The End": 471648,
};

// Events that are not films and should be silently dropped before enrichment.
const NON_FILM_TITLES = new Set([
  // Cinemagic recurring trivia night
  "The Movie Quiz",
  // CST special double-feature event, not a single film
  "An Evening with Alex Cox: Dead Souls & Walker",
]);

function apiKey(): string {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY is not set");
  return key;
}

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // throwOnHttpError:false + a path-based message keeps the api_key out of error/retry logs.
  const res = await fetchWithRetry(
    url.toString(),
    { headers: { "User-Agent": "small-screens-pdx/0.1" } },
    { label: "TMDB", throwOnHttpError: false }
  );
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

interface TmdbSearchResult {
  id: number;
  title: string;
  release_date: string;
  poster_path: string | null;
  genre_ids: number[];
}

interface TmdbMovieDetails {
  id: number;
  title: string;
  release_date: string;
  overview: string;
  poster_path: string | null;
  runtime: number | null;
  genres: { id: number; name: string }[];
  credits: {
    crew: { job: string; name: string }[];
  };
  external_ids: {
    imdb_id: string | null;
  };
}

async function fetchDetails(id: number): Promise<TmdbMovieDetails> {
  return tmdbGet<TmdbMovieDetails>(`/movie/${id}`, { append_to_response: "credits,external_ids" });
}

// Several venues (notably Clinton Street) format titles as "Title (YYYY)".
// TMDB's full-text search chokes on the embedded year — it belongs in the
// primary_release_year filter, not the query string. Pull it out.
function parseTitleYear(raw: string): { title: string; year: number | null } {
  const m = raw.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m) return { title: m[1].trim(), year: parseInt(m[2], 10) };
  return { title: raw, year: null };
}

// Venues sometimes tack event flair onto a real title: "BACKROOMS: Everything
// Must Go Ed. w/ Extra Footage", "UNCLE SAM (1996) ON THE FOURTH OF JULY". When
// the verbatim title fails to match, peel off the tacked-on part and retry —
// conservatively, since a wrong guess means the wrong poster/director/overview
// gets attached to a real showtime.
interface FallbackCandidate {
  searchTitle: string;
  year: number | null;
  eventNote: string;
}

function fallbackCandidates(raw: string): FallbackCandidate[] {
  const candidates: FallbackCandidate[] = [];

  // "Title (YYYY) trailing flair" — year embedded mid-string, not at the end.
  const midYear = raw.match(/^(.*?)\s*\((\d{4})\)\s*(.+)$/);
  if (midYear) {
    const [, title, year, trailing] = midYear;
    candidates.push({ searchTitle: title.trim(), year: parseInt(year, 10), eventNote: trailing.trim() });
  }

  // "Title: flair" / "Title w/ flair" / "Title – flair" — truncate at the first delimiter.
  const delimiterMatch = raw.match(/^(.+?)\s*(?::|w\/|–|-)\s*(.+)$/i);
  if (delimiterMatch) {
    const [, title, trailing] = delimiterMatch;
    if (title.trim().length >= 3) {
      candidates.push({ searchTitle: title.trim(), year: null, eventNote: trailing.trim() });
    }
  }

  return candidates;
}

// Only auto-accept an ambiguous fallback search if it can be disambiguated with
// high confidence; otherwise stay Unverified rather than guess.
async function findConfidentCandidate(
  results: TmdbSearchResult[],
  runtimeMinutes: number | null,
  year: number | null,
  searchTitle: string
): Promise<TmdbSearchResult | null> {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  if (year) {
    const yearMatches = results.filter((r) => r.release_date?.startsWith(String(year)));
    if (yearMatches.length === 1) return yearMatches[0];
  }

  // A candidate whose title matches exactly and has an actual release date beats
  // undated/uncatalogued duplicates (fan re-uploads, placeholder entries) — this
  // catches cases like "extended cut" showings where runtime won't line up with
  // the theatrical release's runtime.
  const exactWithDate = results.filter(
    (r) => r.title.toLowerCase() === searchTitle.toLowerCase() && r.release_date
  );
  if (exactWithDate.length === 1) return exactWithDate[0];

  if (runtimeMinutes) {
    const scored: { r: TmdbSearchResult; diff: number }[] = [];
    for (const r of results.slice(0, 5)) {
      try {
        const details = await fetchDetails(r.id);
        scored.push({ r, diff: Math.abs((details.runtime ?? 0) - runtimeMinutes) });
      } catch {
        // skip unusable candidate
      }
    }
    scored.sort((a, b) => a.diff - b.diff);
    const [best, second] = scored;
    if (best && best.diff <= 5 && (!second || second.diff - best.diff >= 10)) return best.r;
  }

  return null;
}

async function findBestCandidate(
  results: TmdbSearchResult[],
  runtimeMinutes: number | null,
  year: number | null
): Promise<TmdbSearchResult> {
  if (results.length === 1) return results[0];

  // With no runtime to match on (common for venues that omit it), fall back to
  // the parsed release year so we don't blindly take the first fuzzy result.
  if (!runtimeMinutes) {
    if (year) {
      const yearMatch = results.find((r) => r.release_date?.startsWith(String(year)));
      if (yearMatch) return yearMatch;
    }
    return results[0];
  }

  let best = results[0];
  let bestDiff = Infinity;

  for (const r of results.slice(0, 5)) {
    try {
      const details = await fetchDetails(r.id);
      const diff = Math.abs((details.runtime ?? 0) - runtimeMinutes);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = r;
        if (diff <= 5) break;
      }
    } catch {
      // skip unusable candidate
    }
  }

  return best;
}

async function searchTmdb(searchTitle: string, year: number | null): Promise<TmdbSearchResult[]> {
  const params: Record<string, string> = { query: searchTitle };
  if (year) params.primary_release_year = String(year);
  let results = (await tmdbGet<{ results: TmdbSearchResult[] }>("/search/movie", params)).results;

  // The year filter can be too strict if TMDB's primary_release_year differs
  // from the venue's stated year (re-releases, regional dates). Retry without it.
  if (results.length === 0 && year) {
    results = (await tmdbGet<{ results: TmdbSearchResult[] }>("/search/movie", { query: searchTitle })).results;
  }
  return results;
}

export async function enrichFilm(film: Film): Promise<Film> {
  if (film.id !== null) return film;

  let tmdbId: number;
  let eventNote: string | null = null;
  let matchConfidence: "verified" | "fallback" = "verified";
  const overrideId = TMDB_ID_OVERRIDES[film.title];

  if (overrideId) {
    tmdbId = overrideId;
  } else {
    const { title: searchTitle, year: searchYear } = parseTitleYear(film.title);
    let results: TmdbSearchResult[];
    try {
      results = await searchTmdb(searchTitle, searchYear);
    } catch (err) {
      console.warn(`  TMDB search failed for "${film.title}":`, err);
      return film;
    }

    if (results.length > 0) {
      const candidate = await findBestCandidate(results, film.runtime_minutes, searchYear);
      tmdbId = candidate.id;
    } else {
      // Verbatim title didn't match — the title likely has event flair tacked
      // on (see fallbackCandidates). Try each conservatively; take the first
      // one that resolves unambiguously.
      let resolved: { id: number; eventNote: string } | null = null;
      for (const candidate of fallbackCandidates(film.title)) {
        let fallbackResults: TmdbSearchResult[];
        try {
          fallbackResults = await searchTmdb(candidate.searchTitle, candidate.year);
        } catch {
          continue;
        }
        const match = await findConfidentCandidate(fallbackResults, film.runtime_minutes, candidate.year, candidate.searchTitle);
        if (match) {
          resolved = { id: match.id, eventNote: candidate.eventNote };
          break;
        }
      }

      if (!resolved) {
        console.warn(`  No TMDB results for "${film.title}"`);
        return film;
      }
      tmdbId = resolved.id;
      eventNote = resolved.eventNote;
      matchConfidence = "fallback";
    }
  }

  let details: TmdbMovieDetails;
  try {
    details = await fetchDetails(tmdbId);
  } catch (err) {
    console.warn(`  TMDB detail fetch failed for "${film.title}" (id ${tmdbId}):`, err);
    return film;
  }

  const director = details.credits.crew.find((c) => c.job === "Director")?.name ?? null;
  const year = details.release_date ? parseInt(details.release_date.slice(0, 4)) : null;

  const titleSlug = film.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const slug = year ? `${titleSlug}-${year}` : titleSlug;

  return {
    ...film,
    id: details.id,
    slug,
    year,
    director,
    runtime_minutes: details.runtime ?? film.runtime_minutes,
    overview: details.overview || film.overview,
    poster_path: details.poster_path,
    genres: details.genres.map((g) => g.name),
    imdb_id: details.external_ids.imdb_id,
    match_confidence: overrideId ? "verified" : matchConfidence,
    showtimes: eventNote
      ? film.showtimes.map((s) => ({ ...s, event_note: eventNote }))
      : film.showtimes,
  };
}

export interface FailedMatch {
  title: string;
  slug: string;
  runtime_minutes: number | null;
  venue_id: string;
  reason: string;
}

export interface EnrichResult {
  films: Film[];
  failures: FailedMatch[];
}

export interface EnrichOptions {
  retryTitles?: Set<string>;
  force?: boolean;
  cache?: Record<string, Film>;
}

export async function enrichFilms(films: Film[], opts: EnrichOptions = {}): Promise<EnrichResult> {
  const { retryTitles = new Set(), force = false, cache = {} } = opts;
  const enriched: Film[] = [];
  const failures: FailedMatch[] = [];

  for (const film of films) {
    if (NON_FILM_TITLES.has(film.title)) {
      console.log(`  Skipping: ${film.title} (non-film event)`);
      continue;
    }

    const cached = cache[film.title];
    const shouldSkip = !force && cached && !retryTitles.has(film.title);

    if (shouldSkip) {
      enriched.push({ ...cached, showtimes: film.showtimes });
      console.log(`  Cached:   ${film.title}`);
      continue;
    }

    console.log(`  Enriching: ${film.title}`);
    const result = await enrichFilm(film);
    enriched.push(result);

    if (result.id === null) {
      failures.push({
        title: film.title,
        slug: film.slug,
        runtime_minutes: film.runtime_minutes,
        venue_id: film.showtimes[0]?.venue_id ?? "unknown",
        reason: "No TMDB match found — add to TMDB_ID_OVERRIDES in src/enrich.ts",
      });
    } else {
      cache[film.title] = result;
    }
  }

  return { films: enriched, failures };
}
