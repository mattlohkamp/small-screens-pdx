import type { Film, Showtime } from "../types.js";
import { fetchJson as fetchJsonShared } from "../fetch.js";
import { WINDOW_DAYS } from "../window.js";

const VENUE_ID = "tomorrow";
const BASE = "https://tomorrowtheater.org/wp-json/nj/v1";

// Live events / panels with no film component — grows over time via failed-matches.json
const NON_FILM_TITLES = new Set([
  "Tough Shit with Oregon Humanities: Featuring Sankar Raman, JT Flowers, Kayla Kennett, and Georgia Lee Hussey",
  "Open Court: On Publishing, Culture, and Sports + Portland on Portland",
  "Cookies Hoops Live Podcast",
  "Restorative Justice Showcase & Voices From the Inside: A Youth Music Video Premiere",
]);

interface NJShowtime {
  id: number;
  _datetime: string;         // Unix timestamp string
  showtime_to_show: number[];
  _open_captions: string;    // "" or truthy
  link: string;
}

interface NJShow {
  id: number;
  title: { rendered: string };
  _length: string;           // runtime minutes
  _format: string;           // "35mm", "4K", etc. — often empty
  director: string[];
}

function fetchJson<T>(url: string): Promise<T> {
  return fetchJsonShared<T>(
    url,
    { headers: { "User-Agent": "small-screens-pdx/0.1 (portland cinema aggregator)" } },
    "Tomorrow Theater",
  );
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#8217;/g, "’")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// Unix timestamp → "YYYY-MM-DDTHH:MM" in Pacific time (handles DST correctly)
function unixToLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// "Raiders of the Lost Ark x Portland Arts Week" → "Raiders of the Lost Ark"
// "Sherman's March (4K Restoration)" → "Sherman's March", format "4K DCP"
// Strips event co-presentation labels (" x …", " // …") and format suffixes in parens
function cleanTitle(raw: string): { title: string; format: string | null } {
  let s = raw;
  let format: string | null = null;

  const parenFmt = s.match(/\s*\((4K Restoration|35mm|70mm|16mm|DCP|4K)\)\s*$/i);
  if (parenFmt) {
    const f = parenFmt[1];
    format = /^4K Restoration$/i.test(f) ? "4K DCP" : f;
    s = s.slice(0, s.length - parenFmt[0].length).trim();
  }

  // " x Label" — co-presentation, e.g. "Go Fish x Lesbian Cinema Club"
  s = s.replace(/\s+x\s+.+$/, "").trim();
  // " // Label" — festival context, e.g. "A League of Their Own // Portland Arts Week"
  s = s.replace(/\s+\/\/\s+.+$/, "").trim();
  // " Movie Bingo w/ Host" — interactive event overlay on top of the film
  s = s.replace(/\s+Movie Bingo\b.*/i, "").trim();
  // " w/ Host" — remaining co-host suffixes
  s = s.replace(/\s+w\/\s+.+$/, "").trim();

  return { title: s, format };
}

async function fetchAllShowtimes(dateFrom: number): Promise<NJShowtime[]> {
  // date_to is not respected by the API — fetch all future pages and filter client-side
  const all: NJShowtime[] = [];
  let page = 1;
  while (true) {
    const batch = await fetchJson<NJShowtime[]>(
      `${BASE}/showtime?date_from=${dateFrom}&per_page=100&page=${page}`
    );
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

export async function scrapeTomorrow(): Promise<Film[]> {
  const start = today();
  const end = addDays(start, WINDOW_DAYS - 1);

  // date_from filters to future events; date_to is ignored by API so we filter client-side
  const dateFrom = Math.floor(new Date(start).getTime() / 1000);

  const allShowtimes = await fetchAllShowtimes(dateFrom);

  // Filter to window before fetching show details — avoids hundreds of future-show API calls
  const windowShowtimes = allShowtimes.filter(st => {
    const date = unixToLocal(parseInt(st._datetime)).slice(0, 10);
    return date >= start && date <= end;
  });

  // Only fetch show details for the ~5–15 unique shows in the current window
  const showIds = [...new Set(windowShowtimes.flatMap(st => st.showtime_to_show))];

  const showResults = await Promise.allSettled(
    showIds.map(id => fetchJson<NJShow>(`${BASE}/show/${id}`))
  );
  const showMap = new Map<number, NJShow>();
  showResults.forEach((r, i) => {
    if (r.status === "fulfilled") showMap.set(showIds[i], r.value);
  });

  const filmMap = new Map<number, { title: string; format: string | null; show: NJShow; showtimes: Showtime[] }>();

  for (const st of windowShowtimes) {
    const datetime = unixToLocal(parseInt(st._datetime));

    for (const showId of st.showtime_to_show) {
      const show = showMap.get(showId);
      if (!show) continue;

      const rawTitle = decodeHtml(show.title.rendered);
      if (NON_FILM_TITLES.has(rawTitle)) continue;

      if (!filmMap.has(showId)) {
        const { title, format } = cleanTitle(rawTitle);
        filmMap.set(showId, { title, format: (format ?? show._format) || null, show, showtimes: [] });
      }

      const entry = filmMap.get(showId)!;
      const stFormat = st._open_captions ? "Open Captions" : entry.format;

      entry.showtimes.push({
        venue_id: VENUE_ID,
        datetime,
        format: stFormat,
        ticket_url: st.link,
      });
    }
  }

  return [...filmMap.values()].map(({ title, show, showtimes: sts }) => ({
    id: null,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    title,
    year: null,
    director: show.director[0] ?? null,
    runtime_minutes: parseInt(show._length) || null,
    overview: null,
    poster_path: null,
    genres: [],
    showtimes: sts,
  } satisfies Film));
}

if (process.argv[1].includes("tomorrow")) {
  const films = await scrapeTomorrow();
  console.log(JSON.stringify(films, null, 2));
}
