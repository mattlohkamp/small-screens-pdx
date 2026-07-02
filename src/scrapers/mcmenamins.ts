import * as cheerio from "cheerio";
import type { Film, Showtime } from "../types.js";
import { fetchText } from "../fetch.js";
import { USER_AGENT } from "../version.js";

interface McmVenue {
  id: string;
  url: string;
}

const VENUES: McmVenue[] = [
  { id: "baghdad", url: "https://www.mcmenamins.com/bagdad-theater-pub" },
  { id: "kennedy-school", url: "https://www.mcmenamins.com/kennedy-school/kennedy-school-theater" },
];

function parseRuntime(text: string): number | null {
  const m = text.match(/\((\d+)\)/);
  return m ? parseInt(m[1]) : null;
}

// "date_panel_ST00003212_06142026" → last 8 chars = MMDDYYYY → "2026-06-14"
function parseDateFromPanelId(id: string): string {
  const datePart = id.slice(-8);
  return `${datePart.slice(4, 8)}-${datePart.slice(0, 2)}-${datePart.slice(2, 4)}`;
}

// "11:30am" → "11:30:00", "3pm" → "15:00:00", "7pm" → "19:00:00"
function parseTime(text: string): string {
  const m = text.trim().match(/^(\d+)(?::(\d+))?(am|pm)$/i);
  if (!m) throw new Error(`Cannot parse time: "${text}"`);
  let hour = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

function normalizeTitle(raw: string): { title: string; format: string | null } {
  const ocapMatch = raw.match(/^(.+?)\s*\(OCAP\)\s*$/i);
  if (ocapMatch) return { title: ocapMatch[1].trim(), format: "OC" };
  // Strip dubbed/subbed annotations so TMDB search finds the canonical title
  const cleaned = raw.replace(/\s*\((Dubbed|Subtitled|Subbed)\)\s*$/i, "").trim();
  return { title: cleaned, format: null };
}

async function scrapeVenue(venue: McmVenue): Promise<Film[]> {
  const html = await fetchText(
    venue.url,
    { headers: { "User-Agent": USER_AGENT } },
    `McMenamins ${venue.id}`
  );
  const $ = cheerio.load(html);
  const films: Film[] = [];

  $("div.uk-modal-buytickets").each((_, modal) => {
    const $modal = $(modal);
    const rawTitle = $modal.find("h4.uk-margin-bottom-remove").first().text().trim();
    if (!rawTitle) return;

    const { title, format: baseFormat } = normalizeTitle(rawTitle);
    const runtime = parseRuntime($modal.find("p.uk-modal-runningtime").first().text());
    const showtimes: Showtime[] = [];

    $modal.find("div[id^='date_panel_']").each((_, panel) => {
      const panelId = $(panel).attr("id") ?? "";
      const date = parseDateFromPanelId(panelId);

      $(panel).find("button[onclick]").each((_, btn) => {
        const onclick = $(btn).attr("onclick") ?? "";
        const urlMatch = onclick.match(/window\.open\('([^']+)'\)/);
        const ticketUrl = urlMatch ? urlMatch[1] : null;
        const timeText = $(btn).text().trim();

        let timeStr: string;
        try {
          timeStr = parseTime(timeText);
        } catch {
          return;
        }

        showtimes.push({
          venue_id: venue.id,
          datetime: `${date}T${timeStr}`,
          format: baseFormat,
          ticket_url: ticketUrl,
        } satisfies Showtime);
      });
    });

    if (showtimes.length === 0) return;

    films.push({
      id: null,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title,
      year: null,
      director: null,
      runtime_minutes: runtime,
      overview: null,
      poster_path: null,
      genres: [],
      showtimes,
    } satisfies Film);
  });

  console.log(`  ${venue.id}: ${films.length} films`);
  return films;
}

export async function scrapeMcmenamins(): Promise<Film[]> {
  const results = await Promise.all(VENUES.map(scrapeVenue));
  return results.flat();
}

// Run directly: tsx src/scrapers/mcmenamins.ts
if (process.argv[1].includes("mcmenamins")) {
  const films = await scrapeMcmenamins();
  console.log(JSON.stringify(films, null, 2));
}
