import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { scrapeCinemagic } from "./scrapers/cinemagic.js";
import { scrapeClintontStreet } from "./scrapers/clinton-street.js";
import { scrapeLaurelhurst } from "./scrapers/laurelhurst.js";
import { scrapeMcmenamins } from "./scrapers/mcmenamins.js";
import { scrapeAcademy } from "./scrapers/academy.js";
import { scrapeLivingRoom } from "./scrapers/living-room.js";
import { scrapeOmsi } from "./scrapers/omsi.js";
import { scrapeCinema21 } from "./scrapers/cinema-21.js";
import { scrapeHollywood } from "./scrapers/hollywood.js";
import { closeBrowser } from "./browser.js";
import { enrichFilms } from "./enrich.js";
import { loadCache, saveCache } from "./cache.js";
import { WINDOW_DAYS } from "./window.js";
import type { Schedule, Film } from "./types.js";
import type { FailedMatch } from "./enrich.js";

// Registry: scraper-id → { fn, venueIds covered }
const SCRAPERS: Record<string, { fn: () => Promise<Film[]>; venueIds: string[]; label: string }> = {
  cinemagic:       { fn: scrapeCinemagic,      venueIds: ["cinemagic"],                    label: "Cinemagic" },
  "clinton-street":{ fn: scrapeClintontStreet,  venueIds: ["clinton-street"],               label: "Clinton Street Theater" },
  laurelhurst:     { fn: scrapeLaurelhurst,     venueIds: ["laurelhurst"],                  label: "Laurelhurst Theater" },
  mcmenamins:      { fn: scrapeMcmenamins,      venueIds: ["baghdad", "kennedy-school"],    label: "McMenamins (Baghdad + Kennedy School)" },
  academy:         { fn: scrapeAcademy,         venueIds: ["academy"],                      label: "Academy Theater" },
  "living-room":   { fn: scrapeLivingRoom,      venueIds: ["living-room"],                  label: "Living Room Theaters" },
  omsi:            { fn: scrapeOmsi,            venueIds: ["omsi"],                         label: "OMSI Empirical Theatre" },
  "cinema-21":     { fn: scrapeCinema21,        venueIds: ["cinema-21"],                    label: "Cinema 21" },
  hollywood:       { fn: scrapeHollywood,       venueIds: ["hollywood"],                    label: "Hollywood Theatre" },
};

// Merge films from multiple scrapers: same title → one record, combined showtimes.
function mergeFilms(filmLists: Film[][]): Film[] {
  const byTitle = new Map<string, Film>();
  for (const film of filmLists.flat()) {
    const key = film.title.toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.showtimes = [...existing.showtimes, ...film.showtimes];
    } else {
      byTitle.set(key, { ...film, showtimes: [...film.showtimes] });
    }
  }
  return [...byTitle.values()];
}

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

function loadExistingSchedule(): Schedule | null {
  try {
    return JSON.parse(readFileSync("public/data/upcoming.json", "utf8")) as Schedule;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const force = process.argv.includes("--force");
  const start = today();
  const end = addDays(start, WINDOW_DAYS - 1); // inclusive: start + 6 = 7 days total

  // Determine which scrapers to run
  const allIds = Object.keys(SCRAPERS);
  const selectedIds = args.length > 0 ? args : allIds;
  const unknown = selectedIds.filter(id => !SCRAPERS[id]);
  if (unknown.length) {
    console.error(`Unknown scraper(s): ${unknown.join(", ")}`);
    console.error(`Available: ${allIds.join(", ")}`);
    process.exit(1);
  }

  const partial = selectedIds.length < allIds.length;
  if (partial) {
    console.log(`Scraping: ${selectedIds.join(", ")} (partial update)`);
  }

  const cache = loadCache();
  const retryTitles = force ? new Set<string>() : loadPreviousFailures();

  if (force) {
    console.log("--force: re-enriching all films");
  } else if (retryTitles.size > 0) {
    console.log(`Retrying ${retryTitles.size} previous failure(s), using cache for the rest`);
  }

  // Run selected scrapers in parallel. Isolate failures: one venue being slow or
  // unreachable must not discard the venues that scraped fine.
  const settled = await Promise.allSettled(
    selectedIds.map(async (id) => {
      const { fn, label } = SCRAPERS[id];
      console.log(`Scraping ${label}...`);
      const t = Date.now();
      const films = await fn();
      console.log(`  ${label}: ${films.length} films (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      return films;
    })
  );
  await closeBrowser();

  const freshFilmLists: Film[][] = [];
  const failedScrapers: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      freshFilmLists.push(result.value);
    } else {
      failedScrapers.push(selectedIds[i]);
      console.error(`✗ ${SCRAPERS[selectedIds[i]].label} failed:`, result.reason);
    }
  });

  if (failedScrapers.length === selectedIds.length) {
    throw new Error(`All scrapers failed (${failedScrapers.join(", ")}); aborting without overwriting data.`);
  }

  // Only venues that actually scraped get their showtimes replaced. For partial runs
  // (venues not selected) and for venues whose scraper failed this run, preserve the
  // existing last-known-good showtimes so a transient outage doesn't drop a venue.
  const succeededIds = selectedIds.filter(id => !failedScrapers.includes(id));
  const refreshedVenueIds = new Set(succeededIds.flatMap(id => SCRAPERS[id].venueIds));
  const coversAllVenues =
    refreshedVenueIds.size === new Set(allIds.flatMap(id => SCRAPERS[id].venueIds)).size;

  let baseFilms: Film[] = [];
  if (!coversAllVenues) {
    const existing = loadExistingSchedule();
    if (existing) {
      baseFilms = existing.films.map(film => ({
        ...film,
        showtimes: film.showtimes.filter(s => !refreshedVenueIds.has(s.venue_id)),
      })).filter(film => film.showtimes.length > 0);
    }
  }

  const rawFilms = mergeFilms([baseFilms, ...freshFilmLists]);
  console.log(`  ${rawFilms.length} unique films after merge`);

  // Trim to the 7-day window BEFORE enriching. We don't spend TMDB calls — or
  // emit match-failure noise — on showtimes outside the window we expose.
  const windowedFilms = rawFilms
    .map((film) => ({
      ...film,
      showtimes: film.showtimes.filter(
        (s) => s.datetime >= `${start}T00:00:00` && s.datetime <= `${end}T23:59:59`
      ),
    }))
    .filter((film) => film.showtimes.length > 0);
  console.log(`  ${windowedFilms.length} films within ${start} → ${end}`);

  console.log("Enriching via TMDB...");
  // Enrichment only adds metadata; it leaves showtimes (already windowed) intact.
  const { films, failures } = await enrichFilms(windowedFilms, {
    force,
    retryTitles,
    cache,
  });

  saveCache(cache);

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
      {
        id: "omsi",
        name: "OMSI Empirical Theatre",
        neighborhood: "SE Portland",
        address: "1945 SE Water Ave, Portland OR",
        lat: 45.5083,
        lng: -122.6672,
        website: "https://omsi.edu/exhibits/empirical-theater/",
        group: null,
      },
      {
        id: "cinema-21",
        name: "Cinema 21",
        neighborhood: "NW / Alphabet District",
        address: "616 NW 21st Ave, Portland OR",
        lat: 45.5271,
        lng: -122.6975,
        website: "https://www.cinema21.com",
        group: null,
      },
      {
        id: "hollywood",
        name: "Hollywood Theatre",
        neighborhood: "NE Portland",
        address: "4122 NE Sandy Blvd, Portland OR",
        lat: 45.5315,
        lng: -122.6240,
        website: "https://hollywoodtheatre.org",
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

  if (failedScrapers.length > 0) {
    const labels = failedScrapers.map(id => SCRAPERS[id].label).join(", ");
    console.warn(`\n⚠  Degraded run: ${failedScrapers.length} scraper(s) failed (${labels}).`);
    console.warn(`   Preserved last-known-good showtimes for those venues.`);
  }

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
