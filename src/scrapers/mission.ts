import * as cheerio from "cheerio";
import type { Film, Showtime } from "../types.js";
import { fetchText } from "../fetch.js";
import { USER_AGENT } from "../version.js";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "mission";
const BASE = "https://www.mcmenamins.com";
const PAGE_URL = `${BASE}/mission-theater`;

interface McmEvent {
  value: string;
  title: string;   // may contain <em>film title</em>
  url: string;     // "/events/12345-slug"
  date: string;    // "M/D/YYYY"
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// "7/10/2026" → "2026-07-10"
function parseMcmDate(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Extract the autocomplete event list embedded in the page
function parseAutocomplete(html: string): McmEvent[] {
  // The page embeds two autocomplete blocks (mobile + desktop); parse the first
  const m = html.match(/data-uk-autocomplete="\{source:(\[.*?\])\}"/s);
  if (!m) {
    // The page loaded but the expected event block is gone — almost always a
    // markup change, not an empty calendar. Warn so it's diagnosable rather than
    // silently reporting 0 films.
    console.warn("  Mission Theater: autocomplete event block not found — page markup may have changed");
    return [];
  }
  try {
    // Attribute is HTML-entity-encoded
    const raw = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
    return JSON.parse(raw) as McmEvent[];
  } catch {
    return [];
  }
}

// Extract the movie start time from the event card in the listing HTML
// Falls back to 19:00 (the standard "7pm movie" time at Mission)
function extractEventTime($: cheerio.CheerioAPI, eventPath: string): string {
  const card = $(`a[href="${eventPath}"]`).closest(".tm-panel-card");
  const timeText = card.find(".uk-panel-time").text();
  // "6pm doors; 7pm movie" → extract the movie time
  const movieMatch = timeText.match(/(\d+)(?::(\d+))?\s*(am|pm)\s*(?:movie|film|screening)/i);
  if (movieMatch) {
    let h = parseInt(movieMatch[1]);
    const min = movieMatch[2] ?? "00";
    if (movieMatch[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (movieMatch[3].toLowerCase() === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${min}`;
  }
  return "19:00"; // Mission films are always 7pm
}

export async function scrapeMission(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, WINDOW_DAYS - 1);

  const html = await fetchText(
    PAGE_URL,
    { headers: { "User-Agent": USER_AGENT } },
    "Mission Theater",
  );
  const $ = cheerio.load(html);
  const events = parseAutocomplete(html);

  const films: Film[] = [];

  for (const event of events) {
    // Film screenings have <em>title</em> wrapping in the title field
    if (!event.title.includes("<em>")) continue;

    const date = parseMcmDate(event.date);
    if (!date || date < start || date > end) continue;

    const title = event.title.replace(/<[^>]+>/g, "").trim();
    const time = extractEventTime($, event.url);
    const datetime = `${date}T${time}`;
    const ticketUrl = `${BASE}${event.url}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    const showtime: Showtime = {
      venue_id: VENUE_ID,
      datetime,
      format: null,
      ticket_url: ticketUrl,
    };

    films.push({
      id: null,
      slug,
      title,
      year: null,
      director: null,
      runtime_minutes: null,
      overview: null,
      poster_path: null,
      genres: [],
      showtimes: [showtime],
    } satisfies Film);
  }

  return films;
}

// Run directly: tsx src/scrapers/mission.ts
if (process.argv[1].includes("mission")) {
  const films = await scrapeMission();
  console.log(JSON.stringify(films, null, 2));
}
