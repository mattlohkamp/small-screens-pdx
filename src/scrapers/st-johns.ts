import * as cheerio from "cheerio";
import type { Film, Showtime } from "../types.js";
import { fetchText } from "../fetch.js";
import { USER_AGENT } from "../version.js";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "st-johns";
const SITE_TOKEN = "wa27tvhkay8eqf8wswr30vk6xg";
const SESSIONS_URL = `https://ticketing.useast.veezi.com/sessions?siteToken=${SITE_TOKEN}`;

const MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// "Thursday 2, July" → "2026-07-02"
function parseVeeziDate(text: string): string | null {
  const m = text.trim().match(/(\d+),\s+(\w+)/);
  if (!m) return null;
  const day = parseInt(m[1]);
  const monthIdx = MONTHS[m[2]];
  if (monthIdx === undefined) return null;

  // Use current year; if date appears to be in the past, try next year
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, monthIdx, day);
  if (candidate < now && (now.getTime() - candidate.getTime()) > 7 * 86400 * 1000) {
    year++;
  }

  return `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "4:00 PM" → "16:00"
function parseVeeziTime(text: string): string {
  const m = text.trim().match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return "00:00";
  let h = parseInt(m[1]);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

export async function scrapeStJohns(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, WINDOW_DAYS - 1);

  const html = await fetchText(
    SESSIONS_URL,
    { headers: { "User-Agent": USER_AGENT } },
    "St. Johns Cinema"
  );
  const $ = cheerio.load(html);

  // Multiple .film divs can share the same title (one per screen/hall), so merge by title
  const filmMap = new Map<string, { title: string; showtimes: Showtime[] }>();

  $(".film").each((_, filmEl) => {
    const $film = $(filmEl);
    const title = $film.find("h3.title").first().text().trim();
    if (!title) return;

    const key = title.toLowerCase();
    if (!filmMap.has(key)) filmMap.set(key, { title, showtimes: [] });
    const entry = filmMap.get(key)!;

    $film.find(".date-container").each((_, dateEl) => {
      const $date = $(dateEl);
      const dateText = $date.find("h4.date").first().text().trim();
      const date = parseVeeziDate(dateText);
      if (!date || date < start || date > end) return;

      $date.find("ul.session-times li a").each((_, link) => {
        const href = $(link).attr("href") ?? null;
        const timeText = $(link).find("time").text().trim();
        const time = parseVeeziTime(timeText);
        const datetime = `${date}T${time}`;

        // Page renders each showtime twice: absolute URL then relative URL — keep first
        if (entry.showtimes.some(s => s.datetime === datetime)) return;

        entry.showtimes.push({
          venue_id: VENUE_ID,
          datetime,
          format: null,
          ticket_url: href?.startsWith("http") ? href : href ? `https://ticketing.useast.veezi.com${href}` : null,
        });
      });
    });
  });

  return [...filmMap.values()]
    .filter(({ showtimes }) => showtimes.length > 0)
    .map(({ title, showtimes }) => ({
      id: null,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title,
      year: null,
      director: null,
      runtime_minutes: null,
      overview: null,
      poster_path: null,
      genres: [],
      showtimes,
    } satisfies Film));
}

// Run directly: tsx src/scrapers/st-johns.ts
if (process.argv[1].includes("st-johns")) {
  const films = await scrapeStJohns();
  console.log(JSON.stringify(films, null, 2));
}
