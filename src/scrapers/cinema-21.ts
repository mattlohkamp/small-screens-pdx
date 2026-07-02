import type { Film, Showtime } from "../types.js";
import { fetchJson as fetchJsonShared } from "../fetch.js";
import { USER_AGENT } from "../version.js";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "cinema-21";
const BASE = "https://www.cinema21.com";

interface C21Attribute {
  shortName: string;
  description: string;
  _id: string;
}

interface C21SessionTime {
  date: string;
  time: string;
  bookingLink: string;
  attributes: C21Attribute[];
  isSoldOut: boolean;
  _id: string;
}

// playing-now nests director as a full film object; coming-soon uses string[]
interface C21Film {
  url: string;
  title: string;
  duration: string;
  director: { director: string[] } | string[];
  sessionTimes: C21SessionTime[];
}

function fetchJson<T>(url: string): Promise<T> {
  return fetchJsonShared<T>(
    url,
    { headers: { "User-Agent": USER_AGENT } },
    "Cinema 21"
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function windowEnd(): string {
  const d = new Date();
  d.setDate(d.getDate() + WINDOW_DAYS - 1);
  return d.toISOString().slice(0, 10);
}

function parseTime(time: string): string {
  const m = time.match(/^(\d+):(\d+)(am|pm)$/i);
  if (!m) return "00:00";
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toLowerCase();
  if (ampm === "am") {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h += 12;
  }
  return `${h.toString().padStart(2, "0")}:${min}`;
}

function extractDirector(d: C21Film["director"]): string | null {
  if (Array.isArray(d)) return d[0] ?? null;
  return d.director[0] ?? null;
}

function parseTitleYear(raw: string): { title: string; year: number | null } {
  const m = raw.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  if (m) return { title: m[1].trim(), year: parseInt(m[2], 10) };
  return { title: raw.trim(), year: null };
}

export async function scrapeCinema21(): Promise<Film[]> {
  const start = today();
  const end = windowEnd();

  const raw = await fetchJson<C21Film[]>(`${BASE}/api/movie/playing-now`);

  const films: Film[] = [];

  for (const film of raw) {
    const showtimes: Showtime[] = [];

    for (const s of film.sessionTimes) {
      if (s.date < start || s.date > end) continue;
      const attrs = s.attributes.map(a => a.shortName);
      showtimes.push({
        venue_id: VENUE_ID,
        datetime: `${s.date}T${parseTime(s.time)}`,
        format: attrs.includes("OPEN CAPS") ? "Open Captions" : null,
        ticket_url: s.bookingLink || null,
      });
    }

    if (!showtimes.length) continue;

    const { title, year } = parseTitleYear(film.title);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    films.push({
      id: null,
      slug,
      title,
      year,
      director: extractDirector(film.director),
      runtime_minutes: parseInt(film.duration, 10) || null,
      overview: null,
      poster_path: null,
      genres: [],
      showtimes,
    } satisfies Film);
  }

  return films;
}

// Run directly: tsx src/scrapers/cinema-21.ts
if (process.argv[1].includes("cinema-21")) {
  const films = await scrapeCinema21();
  console.log(JSON.stringify(films, null, 2));
}
