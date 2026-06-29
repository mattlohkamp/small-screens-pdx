import type { Film, Showtime } from "../types.js";
import { fetchJson as fetchJsonShared } from "../fetch.js";

const VENUE_ID = "academy";
const BASE = "https://www.academytheaterpdx.com";
const THEATER_ID = "X07OU";
const TZ = "America/Los_Angeles";

interface ScheduledMovies {
  movieIds: { titleAsc: string[] };
  scheduledDays: Record<string, string[]>;
}

interface Showing {
  id: string;
  startsAt: string;
  tags: string[];
  isExpired: boolean;
  data: { ticketing: Array<{ urls: string[]; type: string; provider: string }> };
  screen: { name: string };
}

interface DaySchedule {
  [date: string]: Showing[];
}

interface ScheduleResponse {
  [theaterId: string]: {
    schedule: Record<string, DaySchedule>;
  };
}

interface MovieDetail {
  id: string;
  title: string;
  runtime: number | null; // seconds
  genres: string;
  directors?: { nodes: Array<{ person: { firstName: string; lastName: string } }> };
  synopsis?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fetchJson<T>(url: string): Promise<T> {
  return fetchJsonShared<T>(
    url,
    { headers: { "User-Agent": "small-screens-pdx/0.1 (portland cinema aggregator)" } },
    "Academy"
  );
}

function formatTag(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.includes("35mm")) return "35mm";
    if (tag.includes("70mm")) return "70mm";
    if (tag.includes("Digital")) return "DCP";
    if (tag.includes("Dubbed")) return "Dubbed";
    if (tag.includes("Subtitled")) return "Subtitled";
  }
  return null;
}

function ticketUrl(showing: Showing): string | null {
  // Prefer the "default" provider desktop URL
  const entry = showing.data.ticketing.find(t => t.provider === "default" && t.type === "DESKTOP");
  return entry?.urls[0] ?? showing.data.ticketing[0]?.urls[0] ?? null;
}

export async function scrapeAcademy(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, 14);

  const theatersParam = encodeURIComponent(JSON.stringify({ id: THEATER_ID, timeZone: TZ }));
  const fromParam = encodeURIComponent(`${start}T03:00:00`);
  const toParam = encodeURIComponent(`${end}T03:00:00`);

  const [scheduled, scheduleData] = await Promise.all([
    fetchJson<ScheduledMovies>(`${BASE}/api/gatsby-source-boxofficeapi/scheduledMovies?theaterId=${THEATER_ID}`),
    fetchJson<ScheduleResponse>(`${BASE}/api/gatsby-source-boxofficeapi/schedule?from=${fromParam}&theaters=${theatersParam}&to=${toParam}`),
  ]);

  const movieIds = scheduled.movieIds.titleAsc;
  if (!movieIds.length) return [];

  // Fetch movie details in batches of 20
  const details: MovieDetail[] = [];
  for (let i = 0; i < movieIds.length; i += 20) {
    const batch = movieIds.slice(i, i + 20);
    const qs = batch.map(id => `ids=${id}`).join("&");
    const batchDetails = await fetchJson<MovieDetail[]>(`${BASE}/api/gatsby-source-boxofficeapi/movies?basic=false&castingLimit=1&${qs}`);
    details.push(...batchDetails);
  }

  const detailsById = new Map(details.map(d => [d.id, d]));
  const theaterSchedule = scheduleData[THEATER_ID]?.schedule ?? {};

  const films: Film[] = [];

  for (const movieId of movieIds) {
    const detail = detailsById.get(movieId);
    if (!detail) continue;

    const daySchedule = theaterSchedule[movieId] ?? {};
    const showtimes: Showtime[] = [];

    for (const [_date, showings] of Object.entries(daySchedule)) {
      for (const showing of showings) {
        if (showing.isExpired) continue;
        showtimes.push({
          venue_id: VENUE_ID,
          datetime: showing.startsAt,
          format: formatTag(showing.tags),
          ticket_url: ticketUrl(showing),
        });
      }
    }

    if (!showtimes.length) continue;

    const title = detail.title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    const director = detail.directors?.nodes[0]
      ? `${detail.directors.nodes[0].person.firstName} ${detail.directors.nodes[0].person.lastName}`.trim()
      : null;

    films.push({
      id: null,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title,
      year: null,
      director,
      runtime_minutes: detail.runtime ? Math.round(detail.runtime / 60) : null,
      overview: null,
      poster_path: null,
      genres: detail.genres ? detail.genres.split(",").map(g => g.trim()) : [],
      showtimes,
    } satisfies Film);
  }

  return films;
}

// Run directly: tsx src/scrapers/academy.ts
if (process.argv[1].includes("academy")) {
  const films = await scrapeAcademy();
  console.log(JSON.stringify(films, null, 2));
}
