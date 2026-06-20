import "dotenv/config";
import type { Film } from "./types.js";

const TMDB_BASE = "https://api.themoviedb.org/3";

// Venue titles that are misspelled or too obscure to match via search.
// Key: exact title string from the venue site. Value: TMDB integer ID.
const TMDB_ID_OVERRIDES: Record<string, number> = {
  "964 Pinnochio": 50162,
  // CST title uses the original German title; TMDB has it as "Anita – Dances of Vice"
  "ANITA: DANCES OF VICE (1987)": 131338,
  // CST title uses the full English subtitle; TMDB canonical is slightly different
  "IT IS BETTER TO BE WEALTHY & HEALTHY THAN POOR & ILL (1992)": 259436,
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

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "small-screens-pdx/0.1" },
  });
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
}

async function fetchDetails(id: number): Promise<TmdbMovieDetails> {
  return tmdbGet<TmdbMovieDetails>(`/movie/${id}`, { append_to_response: "credits" });
}

async function findBestCandidate(
  results: TmdbSearchResult[],
  runtimeMinutes: number | null
): Promise<TmdbSearchResult> {
  if (results.length === 1 || !runtimeMinutes) return results[0];

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

export async function enrichFilm(film: Film): Promise<Film> {
  if (film.id !== null) return film;

  let tmdbId: number;
  const overrideId = TMDB_ID_OVERRIDES[film.title];

  if (overrideId) {
    tmdbId = overrideId;
  } else {
    let searchResults: { results: TmdbSearchResult[] };
    try {
      searchResults = await tmdbGet<{ results: TmdbSearchResult[] }>("/search/movie", {
        query: film.title,
      });
    } catch (err) {
      console.warn(`  TMDB search failed for "${film.title}":`, err);
      return film;
    }

    if (searchResults.results.length === 0) {
      console.warn(`  No TMDB results for "${film.title}"`);
      return film;
    }

    const candidate = await findBestCandidate(searchResults.results, film.runtime_minutes);
    tmdbId = candidate.id;
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
