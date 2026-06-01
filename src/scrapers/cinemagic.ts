import * as cheerio from "cheerio";
import type { Film, Showtime } from "../types.js";

const BASE = "https://tickets.thecinemagictheater.com";
const VENUE_ID = "cinemagic";

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "small-screens-pdx/0.1 (portland cinema aggregator)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// Parse ISO 8601 duration like "PT3H49M" or "PT1H45M" → minutes
function parseDuration(iso: string): number | null {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  return (parseInt(m[1] ?? "0") * 60) + parseInt(m[2] ?? "0");
}

// Normalise a showtime link's text + URL to a Showtime record.
// The link text from the film page is like "May 31, 2:00 pm"
function parseShowtime(dateText: string, href: string): Showtime | null {
  // Expected formats: "May 31, 2:00 pm" or "June 1, 7:00 PM"
  const match = dateText.match(
    /(\w+ \d+),\s*(\d+):(\d+)\s*(am|pm)/i
  );
  if (!match) return null;

  const [, monthDay, hourStr, minStr, ampm] = match;
  const year = new Date().getFullYear();
  const date = new Date(`${monthDay} ${year}`);
  if (isNaN(date.getTime())) return null;

  let hour = parseInt(hourStr);
  const min = parseInt(minStr);
  if (ampm.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;

  const pad = (n: number) => String(n).padStart(2, "0");
  const datetime = `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(min)}:00`;

  return {
    venue_id: VENUE_ID,
    datetime,
    format: null,
    ticket_url: href.startsWith("http") ? href : `${BASE}${href}`,
  };
}

async function scrapeFilmPage(slug: string): Promise<Partial<Film> & { showtimes: Showtime[] }> {
  const url = `${BASE}/movie/${slug}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Metadata — the site embeds JSON-LD or microdata; fall back to visible text
  let title = $("h1").first().text().trim();
  let director: string | null = null;
  let runtime_minutes: number | null = null;
  let overview: string | null = null;
  let year: number | null = null;
  let genres: string[] = [];

  // JSON-LD structured data (if present)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() ?? "");
      if (data["@type"] === "Movie" || data.name) {
        if (data.name && !title) title = data.name;
        if (data.director?.name) director = data.director.name;
        if (data.duration) runtime_minutes = parseDuration(data.duration);
        if (data.description) overview = cheerio.load(data.description).text().trim();
        if (data.datePublished) year = parseInt(data.datePublished.slice(0, 4));
        if (data.genre) {
          genres = Array.isArray(data.genre) ? data.genre : [data.genre];
        }
      }
    } catch {
      // not valid JSON-LD, skip
    }
  });

  // Showtimes: links to /checkout/showing/...
  const showtimes: Showtime[] = [];
  $('a[href*="/checkout/showing/"]').each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href") ?? "";
    const st = parseShowtime(text, href);
    if (st) showtimes.push(st);
  });

  const slug_clean = slug.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filmSlug = year ? `${slug_clean}-${year}` : slug_clean;

  return { title, director, runtime_minutes, overview, year, genres, showtimes, slug: filmSlug };
}

export async function scrapeCinemagic(): Promise<Film[]> {
  const html = await fetchHtml(`${BASE}/now-showing/`);
  const $ = cheerio.load(html);

  // Collect film slugs from now-showing page
  const slugs = new Set<string>();
  $('a[href*="/movie/"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/\/movie\/([^/?#]+)/);
    if (m) slugs.add(m[1]);
  });

  console.log(`Found ${slugs.size} films on now-showing page`);

  const films: Film[] = [];
  for (const slug of slugs) {
    console.log(`  Scraping: ${slug}`);
    try {
      const data = await scrapeFilmPage(slug);
      films.push({
        id: null,
        slug: data.slug ?? slug,
        title: data.title ?? slug,
        year: data.year ?? null,
        director: data.director ?? null,
        runtime_minutes: data.runtime_minutes ?? null,
        overview: data.overview ?? null,
        poster_path: null,
        genres: data.genres ?? [],
        showtimes: data.showtimes,
      });
    } catch (err) {
      console.error(`  Error scraping ${slug}:`, err);
    }
  }

  return films;
}

// Run directly: tsx src/scrapers/cinemagic.ts
if (process.argv[1].includes("cinemagic")) {
  const films = await scrapeCinemagic();
  console.log(JSON.stringify(films, null, 2));
}
