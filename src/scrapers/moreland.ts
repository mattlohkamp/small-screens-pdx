import type { Film, Showtime } from "../types.js";
import { fetchJson as fetchJsonShared } from "../fetch.js";
import { USER_AGENT } from "../version.js";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "moreland";
const SCHEDULE_URL = "https://app.formovietickets.com/schedules/scheduleV1/L697452.json";
const TICKET_URL = "https://morelandtheater.com/tickets/";

interface FMTShow {
  time: string; // "2026-07-22T11:00:00" local Pacific
  Id: number;
  place: number;
  info: number[];
  so: boolean; // sold out
}

interface FMTTitle {
  title: string;
  rating: string;
  lengthsecs: number;
  synopsis: string;
  ReleaseUS: string;
  Shows: FMTShow[];
}

interface FMTSchedule {
  location: {
    name: string;
    Titles: FMTTitle[];
  };
}

function fetchJson<T>(url: string): Promise<T> {
  return fetchJsonShared<T>(
    url,
    { headers: { "User-Agent": USER_AGENT } },
    "Moreland Theater"
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// "WILD ROBOT" → "Wild Robot", "TOY STORY 5" → "Toy Story 5"
function titleCase(s: string): string {
  return s === s.toUpperCase()
    ? s.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
    : s;
}

export async function scrapeMoreland(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, WINDOW_DAYS - 1);

  const data = await fetchJson<FMTSchedule>(SCHEDULE_URL);
  const films: Film[] = [];

  for (const entry of data.location.Titles) {
    const showtimes: Showtime[] = [];

    for (const show of entry.Shows) {
      // time is local Pacific with no timezone suffix
      const date = show.time.slice(0, 10);
      if (date < start || date > end) continue;

      showtimes.push({
        venue_id: VENUE_ID,
        datetime: show.time, // already "YYYY-MM-DDTHH:MM:SS" local
        format: null,
        ticket_url: TICKET_URL,
      });
    }

    if (!showtimes.length) continue;

    const title = titleCase(entry.title);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    // Extract year from ReleaseUS if available
    const releaseYear = entry.ReleaseUS ? new Date(entry.ReleaseUS).getFullYear() : null;

    films.push({
      id: null,
      slug,
      title,
      year: releaseYear ?? null,
      director: null,
      runtime_minutes: entry.lengthsecs ? Math.round(entry.lengthsecs / 60) : null,
      overview: entry.synopsis || null,
      poster_path: null,
      genres: [],
      showtimes,
    } satisfies Film);
  }

  return films;
}

// Run directly: tsx src/scrapers/moreland.ts
if (process.argv[1].includes("moreland")) {
  const films = await scrapeMoreland();
  console.log(JSON.stringify(films, null, 2));
}
