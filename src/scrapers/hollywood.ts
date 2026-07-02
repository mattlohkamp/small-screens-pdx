import type { Film, Showtime } from "../types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "hollywood";
const BASE = "https://hollywoodtheatre.org";

// Non-film recurring events in Hollywood's calendar
const NON_FILM: Set<string> = new Set([
  "My Own Private Miniplex",
  // A 4-week film class ("Enrollment is limited to 18 students"), not a
  // screening — the WP title's date/time is a class session, not a showtime.
  "Jim Jarmusch's America",
]);

// Hollywood reuses their generic "event" WP post type for non-screening posts
// (blog/podcast series, etc.) with a date/time suffix baked into the title just
// like real screenings — but with an empty body and no ticketing info, and they
// don't appear on Hollywood's public calendar. Filter by known series prefixes.
const NON_FILM_PREFIXES: string[] = [
  "The World is Wrong About",
];

const execFileAsync = promisify(execFile);

interface WPEvent {
  id: number;
  title: { rendered: string };
  link: string;
}

const MAX_ATTEMPTS = 4;
// A real browser UA — Cloudflare's Bot Fight Mode challenges obvious bot UAs, and this
// venue fronts its API with CF. Node's native fetch is blocked outright (TLS fingerprint),
// so we shell out to curl, whose fingerprint CF accepts.
const CURL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function curlJson<T>(url: string): Promise<T> {
  // CF serves intermittent 403/503 challenges, especially to datacenter IPs (CI runners),
  // and curl --fail exits 22 on those. Each attempt is a fresh CF evaluation, so retrying
  // with backoff recovers most runs rather than dropping the whole venue on one challenge.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { stdout } = await execFileAsync("curl", [
        "-s", "--fail", "--max-time", "30",
        "-H", `User-Agent: ${CURL_UA}`,
        "-H", "Accept: application/json",
        "-H", "Accept-Language: en-US,en;q=0.9",
        url,
      ]);
      return JSON.parse(stdout) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const delay = attempt * 2000;
        console.warn(`  Hollywood curl failed (attempt ${attempt}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// "2026-07-06 7:30pm" → "2026-07-06T19:30"
function parseDatetime(s: string): string {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d+):(\d+)(am|pm)$/i);
  if (!m) return s;
  let h = parseInt(m[2], 10);
  const min = m[3];
  if (m[4].toLowerCase() === "pm" && h !== 12) h += 12;
  if (m[4].toLowerCase() === "am" && h === 12) h = 0;
  return `${m[1]}T${h.toString().padStart(2, "0")}:${min}`;
}

// "THE THIRD MAN in 35mm" → { title: "The Third Man", year: null, format: "35mm" }
function parseRawTitle(raw: string): { title: string; year: number | null; format: string | null } {
  let s = raw;
  let format: string | null = null;

  const fmtMatch = s.match(/\s+in\s+(35mm|70mm|16mm|DCP|4K)\s*$/i);
  if (fmtMatch) {
    const f = fmtMatch[1].toUpperCase();
    format = f === "DCP" ? "DCP" : fmtMatch[1].toLowerCase();
    s = s.slice(0, -fmtMatch[0].length).trim();
  }

  const ocapMatch = s.match(/\s+with\s+open\s+captions?\s*$/i);
  if (ocapMatch) {
    format = format ?? "Open Captions";
    s = s.slice(0, -ocapMatch[0].length).trim();
  }

  let year: number | null = null;
  const yearMatch = s.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (yearMatch) {
    s = yearMatch[1].trim();
    year = parseInt(yearMatch[2], 10);
  }

  // Normalize ALL-CAPS titles to Title Case
  const title = s === s.toUpperCase()
    ? s.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
    : s;

  return { title, year, format };
}

function windowMonths(start: string, end: string): string[] {
  const months = new Set<string>();
  const d = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (d <= endDate) {
    months.add(d.toISOString().slice(0, 7));
    d.setMonth(d.getMonth() + 1);
  }
  return [...months];
}

async function fetchEventsForMonth(yearMonth: string): Promise<WPEvent[]> {
  const all: WPEvent[] = [];
  let page = 1;
  while (true) {
    const url = `${BASE}/wp-json/wp/v2/event?search=${yearMonth}&per_page=100&page=${page}&_fields=id,title,link&orderby=id&order=asc`;
    const batch = await curlJson<WPEvent[]>(url);
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

export async function scrapeHollywood(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, WINDOW_DAYS - 1);
  const months = windowMonths(start, end);

  const allEvents = (await Promise.all(months.map(fetchEventsForMonth))).flat();

  const filmMap = new Map<string, { title: string; year: number | null; showtimes: Showtime[] }>();

  for (const event of allEvents) {
    const decoded = decodeHtml(event.title.rendered);

    // Title format: "{raw film title} – {YYYY-MM-DD H:MMpm}"
    const parts = decoded.split(" – ");
    if (parts.length < 2) continue;

    const datetimeStr = parts[parts.length - 1];
    if (!/^\d{4}-\d{2}-\d{2}\s+\d/.test(datetimeStr)) continue;

    const rawTitle = parts.slice(0, -1).join(" – ");
    const { title, year, format } = parseRawTitle(rawTitle);
    const datetime = parseDatetime(datetimeStr);

    const date = datetime.slice(0, 10);
    if (date < start || date > end) continue;

    if (NON_FILM.has(title) || title.toLowerCase().startsWith("miniplex")) continue;
    if (NON_FILM_PREFIXES.some((p) => title.startsWith(p))) continue;

    const key = title.toLowerCase();
    if (!filmMap.has(key)) {
      filmMap.set(key, { title, year, showtimes: [] });
    }

    filmMap.get(key)!.showtimes.push({
      venue_id: VENUE_ID,
      datetime,
      format,
      ticket_url: event.link,
    });
  }

  return [...filmMap.values()].map(({ title, year, showtimes }) => ({
    id: null,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    title,
    year,
    director: null,
    runtime_minutes: null,
    overview: null,
    poster_path: null,
    genres: [],
    showtimes,
  } satisfies Film));
}

// Run directly: tsx src/scrapers/hollywood.ts
if (process.argv[1].includes("hollywood")) {
  const films = await scrapeHollywood();
  console.log(JSON.stringify(films, null, 2));
}
