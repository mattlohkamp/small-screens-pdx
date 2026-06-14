import type { Film, Showtime } from "../types.js";

const VENUE_ID = "laurelhurst";
const BASE = "https://www.laurelhursttheater.com";
const TICKET_BASE = "https://3677.formovietickets.com:2235/T.ASP?WCI=bt&Page=PickTickets&SHOWID=";

interface LaurelhurstShowtime {
  timeStr: string;
  dateTimeCMP: string; // "YYYYMMDDHHMM" 24h
  onlineSale: string;
  soldOutFlag: string;
  rtsSaleID_pk: string;
}

interface LaurelhurstFilm {
  rtsFilmCode_pk: string;
  title: string;
  lengthMin: string;
  rating: string;
  movieUrl: string | null;
  schedule: Record<string, LaurelhurstShowtime[]>;
}

async function fetchHomepage(): Promise<string> {
  const res = await fetch(BASE, {
    headers: { "User-Agent": "small-screens-pdx/0.1 (portland cinema aggregator)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${BASE}`);
  return res.text();
}

function extractGblMovies(html: string): Record<string, LaurelhurstFilm> {
  const match = html.match(/var gbl_movies\s*=\s*(\{[\s\S]*?\});/);
  if (!match) throw new Error("Could not find gbl_movies in Laurelhurst HTML");
  return JSON.parse(match[1]);
}

// "202606131215" → "2026-06-13T12:15:00"
function parseDateTimeCMP(cmp: string): string {
  return `${cmp.slice(0, 4)}-${cmp.slice(4, 6)}-${cmp.slice(6, 8)}T${cmp.slice(8, 10)}:${cmp.slice(10, 12)}:00`;
}

// Strip " (open caption)" suffix; return the format label if it was present.
function normalizeTitle(raw: string): { title: string; format: string | null } {
  const oc = raw.match(/^(.+?)\s*\(open caption\)\s*$/i);
  if (oc) return { title: oc[1].trim(), format: "OC" };
  return { title: raw, format: null };
}

export async function scrapeLaurelhurst(): Promise<Film[]> {
  const html = await fetchHomepage();
  const gblMovies = extractGblMovies(html);

  const entries = Object.values(gblMovies);
  console.log(`  Found ${entries.length} film entries`);

  return entries.map((entry) => {
    const { title, format: baseFormat } = normalizeTitle(entry.title);

    const showtimes: Showtime[] = [];
    for (const [dateKey, times] of Object.entries(entry.schedule)) {
      for (const st of times) {
        showtimes.push({
          venue_id: VENUE_ID,
          datetime: parseDateTimeCMP(st.dateTimeCMP),
          format: baseFormat,
          ticket_url: st.onlineSale === "1" ? `${TICKET_BASE}${st.rtsSaleID_pk}` : null,
        });
      }
    }

    return {
      id: null,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title,
      year: null,
      director: null,
      runtime_minutes: entry.lengthMin ? parseInt(entry.lengthMin) : null,
      overview: null,
      poster_path: null,
      genres: [],
      showtimes,
    } satisfies Film;
  });
}

// Run directly: tsx src/scrapers/laurelhurst.ts
if (process.argv[1].includes("laurelhurst")) {
  const films = await scrapeLaurelhurst();
  console.log(JSON.stringify(films, null, 2));
}
