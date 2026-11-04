import type { Film, Showtime } from "../types.js";
import { fetchJson } from "../fetch.js";
import { USER_AGENT } from "../version.js";
import { WINDOW_DAYS } from "../window.js";

// Cinemagic moved to the INDY ticketing platform (~2026-10-27). Its film pages
// are now a client-rendered SPA, so we query the same GraphQL API the SPA uses.
// Unlike Living Room (also INDY), this endpoint accepts plain HTTP requests as
// long as the site/circuit headers are present — no browser session needed.
const BASE = "https://tickets.thecinemagictheater.com";
const GQL = `${BASE}/graphql`;
const SITE_ID = "40";
const CIRCUIT_ID = "39";
const VENUE_ID = "cinemagic";

interface CMMovie {
  id: string;
  name: string;
  urlSlug: string;
  duration: number | null; // minutes
  directedBy: string | null;
  releaseDate: string | null; // "YYYY-MM-DD"
  synopsis: string | null;
}

interface CMShowing {
  id: string;
  time: string; // UTC ISO
  published: boolean | null;
  movie: CMMovie | null;
}

interface GqlResponse {
  data?: { showingsForDate?: { data: CMShowing[] } };
  errors?: Array<{ message: string }>;
  error?: { message: string };
}

const SHOWINGS_FOR_DATE_QUERY = `query ($date: String, $siteIds: [ID]) {
  showingsForDate(date: $date, siteIds: $siteIds) {
    data {
      id time published
      movie { id name urlSlug duration directedBy releaseDate synopsis }
    }
  }
}`;

// UTC ISO → local Pacific datetime string ("YYYY-MM-DDTHH:MM:SS")
function utcToLocalPacific(utc: string): string {
  return new Date(utc).toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T");
}

// Calendar dates (Pacific) covering the scrape window, starting today.
function windowDates(): string[] {
  const now = Date.now();
  return Array.from({ length: WINDOW_DAYS }, (_, i) =>
    new Date(now + i * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "America/Los_Angeles" })
  );
}

async function fetchShowings(date: string): Promise<CMShowing[]> {
  const res = await fetchJson<GqlResponse>(
    GQL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "site-id": SITE_ID,
        "circuit-id": CIRCUIT_ID,
        "client-type": "consumer",
      },
      body: JSON.stringify({ query: SHOWINGS_FOR_DATE_QUERY, variables: { date, siteIds: [SITE_ID] } }),
    },
    "Cinemagic"
  );
  // INDY reports some failures (e.g. missing site ID) as HTTP 200 + an error body.
  const err = res.errors?.[0]?.message ?? res.error?.message;
  if (err) throw new Error(`Cinemagic GraphQL error for ${date}: ${err}`);
  return res.data?.showingsForDate?.data ?? [];
}

export async function scrapeCinemagic(): Promise<Film[]> {
  const dates = windowDates();
  const perDate = await Promise.all(dates.map(fetchShowings));

  const films = new Map<string, Film>();
  for (const s of perDate.flat()) {
    if (!s.movie || s.published === false) continue;
    const m = s.movie;
    const year = m.releaseDate ? parseInt(m.releaseDate.slice(0, 4)) || null : null;

    let film = films.get(m.id);
    if (!film) {
      const base = (m.urlSlug || m.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      // Some INDY slugs already carry the year ("evil-dead-2013") — don't double it.
      const slug = !year || base.endsWith(`-${year}`) ? base : `${base}-${year}`;
      film = {
        id: null,
        slug,
        title: m.name,
        year,
        director: m.directedBy ?? null,
        runtime_minutes: m.duration ?? null,
        overview: m.synopsis ?? null,
        poster_path: null,
        genres: [],
        showtimes: [],
      };
      films.set(m.id, film);
    }

    const showtime: Showtime = {
      venue_id: VENUE_ID,
      datetime: utcToLocalPacific(s.time),
      format: null,
      ticket_url: `${BASE}/checkout/showing/${m.urlSlug}/${s.id}/`,
    };
    film.showtimes.push(showtime);
  }

  const result = [...films.values()];
  const total = result.reduce((n, f) => n + f.showtimes.length, 0);
  if (total === 0) {
    // A full week with nothing scheduled is unusual for Cinemagic — more likely
    // the API/site changed again. Warn so it doesn't fail silently like before.
    console.warn(`  Cinemagic: 0 showings for ${dates[0]}..${dates[dates.length - 1]} — API may have changed`);
  } else {
    console.log(`  ${total} showings across ${result.length} films`);
  }
  return result;
}

// Run directly: tsx src/scrapers/cinemagic.ts
if (process.argv[1].includes("cinemagic")) {
  const films = await scrapeCinemagic();
  console.log(JSON.stringify(films, null, 2));
}
