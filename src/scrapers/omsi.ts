import * as cheerio from "cheerio";
import type { Film, Showtime } from "../types.js";
import { fetchText, fetchWithRetry } from "../fetch.js";

const VENUE_ID = "omsi";
const OMSI_URL = "https://omsi.edu/exhibits/empirical-theater/";
const API_BASE = "https://tickets.omsi.edu/cached_api";
const HEADERS = { "User-Agent": "small-screens-pdx/0.1 (portland cinema aggregator)" };

// Categories that indicate non-film programming to exclude
const NON_FILM_CATEGORIES = new Set(["Matches at the Museum"]);

// Strip OMSI-specific event decorations to get the canonical film title
function normalizeTitle(raw: string): string {
  return raw
    .replace(/\s*[-–]\s*Opening Day Event\s*$/i, "")
    .replace(/\s*[-–]\s*Opening Night\s*$/i, "")
    .trim();
}

interface EventDetails {
  title: string;
  category: string;
  ticketGroupId: string;
}

interface CalendarDate {
  date: string;   // "2026-06-19"
  status: string; // "available" | "unavailable" | "sold_out"
}

interface EventSession {
  id: string;
  start_datetime: string; // UTC ISO e.g. "2026-06-20T23:00:00Z"
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// UTC ISO → local Pacific datetime string (no timezone suffix)
function utcToLocalPacific(utc: string): string {
  const d = new Date(utc);
  return d.toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T");
}

// Extract all unique event UUIDs from the OMSI theater page
async function fetchEventUUIDs(): Promise<string[]> {
  const html = await fetchText(OMSI_URL, { headers: HEADERS }, "OMSI");
  const $ = cheerio.load(html);
  const uuids = new Set<string>();

  $("a[href*='tickets.omsi.edu/events/']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = href.match(/tickets\.omsi\.edu\/events\/([0-9a-f-]{36})/);
    if (match) uuids.add(match[1]);
  });

  return [...uuids];
}

// Get event title, category, and ticket_group_id from the Eventbrite white-label API
async function fetchEventDetails(uuid: string): Promise<EventDetails | null> {
  const url = `${API_BASE}/events/${uuid}?_embed=ticket_group`;
  const res = await fetchWithRetry(url, { headers: HEADERS }, { label: "OMSI", throwOnHttpError: false });
  if (!res.ok) {
    console.warn(`  OMSI: HTTP ${res.status} for event ${uuid}`);
    return null;
  }
  const json = await res.json() as {
    event_template?: { _data?: Array<{ name?: string; category?: string }> };
    ticket_group?: { _data?: Array<{ id?: string }> };
  };

  const template = json?.event_template?._data?.[0];
  const ticketGroupId = json?.ticket_group?._data?.[0]?.id;
  if (!template || !ticketGroupId) return null;

  return {
    title: template.name ?? "",
    category: template.category ?? "",
    ticketGroupId,
  };
}

// Get available dates in the 2-week window
async function fetchAvailableDates(
  uuid: string,
  ticketGroupId: string,
  start: string,
  end: string
): Promise<string[]> {
  // No start filter — the endpoint returns the rolling window the platform shows.
  // We filter client-side to our window.
  const url = `${API_BASE}/events/${uuid}/calendar?_format=extended&ticket_group_id._in=${ticketGroupId}`;
  const res = await fetchWithRetry(url, { headers: HEADERS }, { label: "OMSI", throwOnHttpError: false });
  if (!res.ok) return [];
  const json = await res.json() as { calendar?: { _data?: CalendarDate[] } };

  return (json?.calendar?._data ?? [])
    .filter(d => d.status === "available" && d.date >= start && d.date <= end)
    .map(d => d.date);
}

// Get all session start times (UTC) for a given date
async function fetchSessionsForDate(
  uuid: string,
  ticketGroupId: string,
  date: string
): Promise<EventSession[]> {
  const url = `${API_BASE}/events/${uuid}/sessions?_ondate=${date}&ticket_group.id._in=${ticketGroupId}`;
  const res = await fetchWithRetry(url, { headers: HEADERS }, { label: "OMSI", throwOnHttpError: false });
  if (!res.ok) return [];
  const json = await res.json() as { event_session?: { _data?: EventSession[] } };
  return json?.event_session?._data ?? [];
}

export async function scrapeOmsi(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, 14);

  console.log("  Fetching OMSI film list...");
  const uuids = await fetchEventUUIDs();
  console.log(`  Found ${uuids.length} event UUIDs`);

  const films: Film[] = [];

  for (const uuid of uuids) {
    const details = await fetchEventDetails(uuid);
    if (!details) continue;
    if (!details.title) continue;

    // Filter out non-film programming
    if (NON_FILM_CATEGORIES.has(details.category)) {
      console.log(`  Skipping non-film event: "${details.title}" (${details.category})`);
      continue;
    }

    const dates = await fetchAvailableDates(uuid, details.ticketGroupId, start, end);
    if (!dates.length) continue;

    const showtimes: Showtime[] = [];
    for (const date of dates) {
      const sessions = await fetchSessionsForDate(uuid, details.ticketGroupId, date);
      for (const session of sessions) {
        const datetime = utcToLocalPacific(session.start_datetime);
        // Double-check the converted datetime is within window
        if (datetime >= `${start}T00:00:00` && datetime <= `${end}T23:59:59`) {
          showtimes.push({
            venue_id: VENUE_ID,
            datetime,
            format: null,
            ticket_url: `https://tickets.omsi.edu/events/${uuid}`,
          });
        }
      }
    }

    if (!showtimes.length) continue;

    const title = normalizeTitle(details.title);
    films.push({
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
    });
    console.log(`  "${title}": ${showtimes.length} showtimes`);
  }

  return films;
}

// Run directly: tsx src/scrapers/omsi.ts
if (process.argv[1].includes("omsi")) {
  const films = await scrapeOmsi();
  console.log(JSON.stringify(films, null, 2));
}
