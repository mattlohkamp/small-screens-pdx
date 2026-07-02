import * as cheerio from "cheerio";
import type { Film, Showtime } from "../types.js";
import { fetchJson } from "../fetch.js";
import { USER_AGENT } from "../version.js";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "clinton-street";
const API_BASE = "https://cstpdx.com/wp-json/tribe/events/v1/events";

interface TribeEvent {
  title: string;
  start_date: string; // "2026-06-13 19:00:00"
  website: string | null;
}

interface TribeResponse {
  events: TribeEvent[];
  next_rest_url?: string;
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchAllEvents(): Promise<TribeEvent[]> {
  const startDate = new Date().toISOString().slice(0, 10);
  const endDate = addDays(WINDOW_DAYS - 1);
  let url: string | undefined =
    `${API_BASE}?per_page=50&status=publish&start_date=${startDate}&end_date=${endDate}`;

  const all: TribeEvent[] = [];
  while (url) {
    const data: TribeResponse = await fetchJson<TribeResponse>(
      url,
      { headers: { "User-Agent": USER_AGENT } },
      "Clinton Street Theater"
    );
    all.push(...(data.events ?? []));
    url = data.next_rest_url;
  }
  return all;
}

function decodeHtml(str: string): string {
  return cheerio.load(str).text();
}

// Strip CST-specific event decorations to get a plain film title for TMDB matching.
// e.g. "The Rocky Horror Picture Show with Sinophelia" → "The Rocky Horror Picture Show"
//      "ANITA: DANCES OF VICE (1987) (Church of Film)"  → "ANITA: DANCES OF VICE (1987)"
//      "Cult Sensation: But I'm a Cheerleader"           → "But I'm a Cheerleader"
function normalizeTitle(raw: string): string {
  let t = decodeHtml(raw).trim();
  // "Rocky Horror Picture Show with <shadowcast>" → canonical film title
  t = t.replace(/^(The Rocky Horror Picture Show)\s+with\s+.+$/i, "$1");
  // "(Church of Film)" series label appended to title
  t = t.replace(/\s*\(Church of Film\)\s*$/i, "").trim();
  // "Cult Sensation: <film title>" → just the film title
  t = t.replace(/^Cult Sensation:\s*/i, "").trim();
  // "<Film Title>: The Midnight Mass Experience" → just the film title
  t = t.replace(/:\s*The Midnight Mass Experience\s*$/i, "").trim();
  return t;
}

export async function scrapeClintontStreet(): Promise<Film[]> {
  const events = await fetchAllEvents();
  console.log(`  Found ${events.length} events`);

  return events.map((evt) => {
    const title = normalizeTitle(evt.title);
    return {
    id: null,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    title,
    year: null,
    director: null,
    runtime_minutes: null,
    overview: null,
    poster_path: null,
    genres: [],
    showtimes: [
      {
        venue_id: VENUE_ID,
        datetime: evt.start_date.replace(" ", "T"),
        format: null,
        ticket_url: evt.website ?? null,
      } satisfies Showtime,
    ],
  };
  });
}

// Run directly: tsx src/scrapers/clinton-street.ts
if (process.argv[1].includes("clinton-street")) {
  const films = await scrapeClintontStreet();
  console.log(JSON.stringify(films, null, 2));
}
