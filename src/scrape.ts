import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { scrapeCinemagic } from "./scrapers/cinemagic.js";
import { scrapeClintontStreet } from "./scrapers/clinton-street.js";
import { scrapeLaurelhurst } from "./scrapers/laurelhurst.js";
import { scrapeMcmenamins } from "./scrapers/mcmenamins.js";
import { scrapeAcademy } from "./scrapers/academy.js";
import { scrapeLivingRoom } from "./scrapers/living-room.js";
import { closeBrowser } from "./browser.js";
import { enrichFilms } from "./enrich.js";
import { loadCache, saveCache } from "./cache.js";
import type { Schedule, Film } from "./types.js";
import type { FailedMatch } from "./enrich.js";

// Merge films from multiple scrapers: same title → one record, combined showtimes.
function mergeFilms(filmLists: Film[][]): Film[] {
  const byTitle = new Map<string, Film>();
  for (const film of filmLists.flat()) {
    const existing = byTitle.get(film.title);
    if (existing) {
      existing.showtimes = [...existing.showtimes, ...film.showtimes];
    } else {
      byTitle.set(film.title, { ...film, showtimes: [...film.showtimes] });
    }
  }
  return [...byTitle.values()];
}

const WINDOW_DAYS = 14;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadPreviousFailures(): Set<string> {
  try {
    const data: FailedMatch[] = JSON.parse(readFileSync("public/data/failed-matches.json", "utf8"));
    return new Set(data.map((f) => f.title));
  } catch {
    return new Set();
  }
}

async function main() {
  const force = process.argv.includes("--force");
  const start = today();
  const end = addDays(start, WINDOW_DAYS);

  const cache = loadCache();
  const retryTitles = force ? new Set<string>() : loadPreviousFailures();

  if (force) {
    console.log("--force: re-enriching all films");
  } else if (retryTitles.size > 0) {
    console.log(`Retrying ${retryTitles.size} previous failure(s), using cache for the rest`);
  }

  console.log("Scraping Cinemagic...");
  const cinemagicFilms = await scrapeCinemagic();
  console.log(`  ${cinemagicFilms.length} films`);

  console.log("Scraping Clinton Street Theater...");
  const cstFilms = await scrapeClintontStreet();
  console.log(`  ${cstFilms.length} films`);

  console.log("Scraping Laurelhurst Theater...");
  const laurelhurstFilms = await scrapeLaurelhurst();
  console.log(`  ${laurelhurstFilms.length} films`);

  console.log("Scraping McMenamins (Baghdad + Kennedy School)...");
  const mcmenaminsFilms = await scrapeMcmenamins();
  console.log(`  ${mcmenaminsFilms.length} films`);

  console.log("Scraping Academy Theater...");
  const academyFilms = await scrapeAcademy();
  console.log(`  ${academyFilms.length} films`);

  console.log("Scraping Living Room Theaters...");
  const livingRoomFilms = await scrapeLivingRoom();
  console.log(`  ${livingRoomFilms.length} films`);
  await closeBrowser();

  // Merge across all scrapers before enriching — shared films get one TMDB call
  const rawFilms = mergeFilms([cinemagicFilms, cstFilms, laurelhurstFilms, mcmenaminsFilms, academyFilms, livingRoomFilms]);
  console.log(`  ${rawFilms.length} unique films after merge`);

  console.log("Enriching via TMDB...");
  const { films: enrichedFilms, failures } = await enrichFilms(rawFilms, {
    force,
    retryTitles,
    cache,
  });

  saveCache(cache);

  // Filter showtimes to the 2-week window and drop films with no remaining showtimes
  const films = enrichedFilms
    .map((film) => ({
      ...film,
      showtimes: film.showtimes.filter(
        (s) => s.datetime >= `${start}T00:00:00` && s.datetime <= `${end}T23:59:59`
      ),
    }))
    .filter((film) => film.showtimes.length > 0);

  const schedule: Schedule = {
    generated_at: new Date().toISOString(),
    window: { start, end },
    venues: [
      {
        id: "cinemagic",
        name: "The Cinemagic Theater",
        neighborhood: "SE Portland",
        address: "2021 SE Hawthorne Blvd, Portland OR",
        lat: 45.5122,
        lng: -122.6366,
        website: "https://www.thecinemagictheater.com",
        group: null,
      },
      {
        id: "clinton-street",
        name: "Clinton Street Theater",
        neighborhood: "SE Portland",
        address: "2522 SE Clinton St, Portland OR",
        lat: 45.5058,
        lng: -122.6482,
        website: "https://www.cstpdx.com",
        group: null,
      },
      {
        id: "laurelhurst",
        name: "Laurelhurst Theater",
        neighborhood: "NE Portland",
        address: "2735 E Burnside St, Portland OR",
        lat: 45.5231,
        lng: -122.6375,
        website: "https://www.laurelhursttheater.com",
        group: null,
      },
      {
        id: "baghdad",
        name: "Bagdad Theater & Pub",
        neighborhood: "SE Portland",
        address: "3702 SE Hawthorne Blvd, Portland OR",
        lat: 45.5120,
        lng: -122.6244,
        website: "https://www.mcmenamins.com/bagdad-theater-pub",
        group: "McMenamins",
      },
      {
        id: "kennedy-school",
        name: "Kennedy School Theater",
        neighborhood: "NE Portland",
        address: "5736 NE 33rd Ave, Portland OR",
        lat: 45.5613,
        lng: -122.6481,
        website: "https://www.mcmenamins.com/kennedy-school/kennedy-school-theater",
        group: "McMenamins",
      },
      {
        id: "academy",
        name: "Academy Theater",
        neighborhood: "SE Portland / Montavilla",
        address: "7818 SE Stark St, Portland OR",
        lat: 45.5191,
        lng: -122.5829,
        website: "https://www.academytheaterpdx.com",
        group: null,
      },
      {
        id: "living-room",
        name: "Living Room Theaters",
        neighborhood: "Downtown",
        address: "341 SW 10th Ave, Portland OR",
        lat: 45.5215,
        lng: -122.6826,
        website: "https://www.livingroomtheaters.com",
        group: null,
      },
    ],
    films,
  };

  mkdirSync("public/data", { recursive: true });
  writeFileSync("public/data/upcoming.json", JSON.stringify(schedule, null, 2));
  console.log(`\nWrote public/data/upcoming.json`);
  console.log(`  ${films.length} films, ${films.flatMap((f) => f.showtimes).length} showtimes`);
  console.log(`  Window: ${start} → ${end}`);

  if (failures.length > 0) {
    writeFileSync("public/data/failed-matches.json", JSON.stringify(failures, null, 2));
    console.log(`\n⚠  ${failures.length} film(s) could not be matched to TMDB:`);
    for (const f of failures) {
      console.log(`   • "${f.title}" (${f.runtime_minutes ?? "?"}min) — ${f.venue_id}`);
    }
    console.log(`\n   Fix: add entries to TMDB_ID_OVERRIDES in src/enrich.ts`);
    console.log(`   Details written to public/data/failed-matches.json`);
  } else {
    console.log("\nAll films matched successfully.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
