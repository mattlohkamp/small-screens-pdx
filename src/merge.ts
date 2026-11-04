// Folding the per-venue scrape output into one record per film.
import type { Film } from "./types.js";

// Projection-format suffixes some venues put in the title, e.g. Hollywood's
// "WILDWOOD (Digital)" or Cinemagic's "The Evil Dead (35mm)". Left in, they split
// one film into two records and usually break the TMDB match too.
const FORMAT_SUFFIXES: [RegExp, string][] = [
  [/\s*[([]\s*(digital|dcp)\s*[)\]]\s*$/i, "Digital"],
  [/\s*[([]\s*(16|35|70)\s?mm\s*[)\]]\s*$/i, "$1mm"],
  [/\s+(?:on|in)\s+(16|35|70)\s?mm\s*$/i, "$1mm"],
];

// Pure: moves a format suffix out of the title onto the film's showtimes (only
// where the scraper didn't already supply a format).
export function stripFormatSuffix(film: Film): Film {
  for (const [re, label] of FORMAT_SUFFIXES) {
    const m = film.title.match(re);
    if (!m) continue;
    const format = label.replace("$1", m[1] ?? "");
    const title = film.title.slice(0, m.index).trim();
    return {
      ...film,
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      showtimes: film.showtimes.map((s) => ({ ...s, format: s.format ?? format })),
    };
  }
  return film;
}

// "WILDWOOD" vs "Wildwood": keep the venue title that isn't shouting.
const isAllCaps = (t: string) => /[A-Z]/.test(t) && t === t.toUpperCase();

// Merge films from multiple scrapers: same title (case-insensitive, after
// stripping format suffixes) → one record, combined showtimes.
export function mergeFilms(filmLists: Film[][]): Film[] {
  const byTitle = new Map<string, Film>();
  for (const film of filmLists.flat().map(stripFormatSuffix)) {
    const key = film.title.toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.showtimes = [...existing.showtimes, ...film.showtimes];
      if (isAllCaps(existing.title) && !isAllCaps(film.title)) {
        existing.title = film.title;
        existing.slug = film.slug;
      }
    } else {
      byTitle.set(key, { ...film, showtimes: [...film.showtimes] });
    }
  }
  return [...byTitle.values()];
}

// Pure: after enrichment, different venue titles can resolve to the same TMDB
// film ("Godzilla Minus Zero" and "Godzilla Minus Zero - Opening Night Event").
// Fold them into one record; per-showtime event_note keeps the distinction.
// The surviving record is the most direct match: verified over fallback, then
// the shortest title.
export function mergeByTmdbId(films: Film[]): Film[] {
  const out: Film[] = [];
  const byId = new Map<number, Film>();
  const rank = (f: Film) => [f.match_confidence === "fallback" ? 1 : 0, f.title.length] as const;
  for (const film of films) {
    if (film.id === null) {
      out.push(film);
      continue;
    }
    const existing = byId.get(film.id);
    if (!existing) {
      const copy = { ...film, showtimes: [...film.showtimes] };
      byId.set(film.id, copy);
      out.push(copy);
      continue;
    }
    const [a, b] = [rank(film), rank(existing)];
    const showtimes = [...existing.showtimes, ...film.showtimes];
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) Object.assign(existing, film);
    existing.showtimes = showtimes;
  }
  return out;
}
