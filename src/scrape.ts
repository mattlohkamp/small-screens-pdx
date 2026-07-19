import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { scrapeCinemagic } from "./scrapers/cinemagic.js";
import { scrapeClintontStreet } from "./scrapers/clinton-street.js";
import { scrapeLaurelhurst } from "./scrapers/laurelhurst.js";
import { scrapeMcmenamins } from "./scrapers/mcmenamins.js";
import { scrapeAcademy } from "./scrapers/academy.js";
import { scrapeLivingRoom } from "./scrapers/living-room.js";
import { scrapeOmsi } from "./scrapers/omsi.js";
import { scrapeCinema21 } from "./scrapers/cinema-21.js";
import { scrapeHollywood } from "./scrapers/hollywood.js";
import { scrapeStJohns } from "./scrapers/st-johns.js";
import { scrapeMoreland } from "./scrapers/moreland.js";
import { scrapeTomorrow } from "./scrapers/tomorrow.js";
import { scrapeMission } from "./scrapers/mission.js";
import { scrapeAvalon } from "./scrapers/avalon.js";
import { closeBrowser } from "./browser.js";
import { withRetry, withTimeout } from "./fetch.js";
import { VERSION } from "./version.js";
import { enrichFilms } from "./enrich.js";
import { loadCache, saveCache } from "./cache.js";
import { WINDOW_DAYS } from "./window.js";
import type { Schedule, Film } from "./types.js";
import type { FailedMatch } from "./enrich.js";

// Hard cap on a single scrape attempt. Longer than any healthy scraper (the
// slowest, Cinemagic, runs ~6s; fetch calls self-abort at 45s) but short enough
// that a wedged venue times out and retries/fails cleanly instead of hanging.
const SCRAPER_TIMEOUT_MS = 90_000;

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
  "st-johns":      { fn: scrapeStJohns,         venueIds: ["st-johns"],                     label: "St. Johns Cinema" },
  moreland:        { fn: scrapeMoreland,         venueIds: ["moreland"],                     label: "Moreland Theater" },
  tomorrow:        { fn: scrapeTomorrow,         venueIds: ["tomorrow"],                     label: "Tomorrow Theater" },
  mission:         { fn: scrapeMission,          venueIds: ["mission"],                      label: "Mission Theater" },
  avalon:          { fn: scrapeAvalon,            venueIds: ["avalon"],                       label: "Avalon Theatre" },
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

// The scrape window is a span of Portland calendar days, and showtime datetimes
// are Portland-local naive strings. Anchor "today" to Portland — NOT UTC — so an
// evening run (already past midnight UTC) still starts the window at the current
// Portland day and keeps its whole day, including already-passed showtimes.
const TIMEZONE = "America/Los_Angeles";

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
}

// Pure date-string arithmetic in UTC (midnight Z) so it never drifts with the
// host machine's timezone; input/output are plain YYYY-MM-DD.
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
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
    return JSON.parse(readFileSync("public/data/showtimes.json", "utf8")) as Schedule;
  } catch {
    return null;
  }
}

async function main() {
  const runStart = new Date();
  const logLines: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    logLines.push(msg);
  };
  try {
    await run(runStart, log);
  } catch (err) {
    log(`=== Scrape run FAILED: ${new Date().toISOString()} ===`);
    log(err instanceof Error ? err.stack ?? err.message : String(err));
    throw err;
  } finally {
    mkdirSync("public/data", { recursive: true });
    appendFileSync("public/data/scrape.log", logLines.join("\n") + "\n");
  }
}

async function run(runStart: Date, log: (msg: string) => void) {
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

  log(`=== Scrape run: ${runStart.toISOString()} (v${VERSION}) ===`);
  const partial = selectedIds.length < allIds.length;
  if (partial) {
    log(`Scraping: ${selectedIds.join(", ")} (partial update)`);
  }

  const cache = loadCache();
  const retryTitles = force ? new Set<string>() : loadPreviousFailures();

  if (force) {
    log("--force: re-enriching all films");
  } else if (retryTitles.size > 0) {
    log(`Retrying ${retryTitles.size} previous failure(s), using cache for the rest`);
  }

  // Run selected scrapers in parallel. Isolate failures: one venue being slow or
  // unreachable must not discard the venues that scraped fine.
  const settled = await Promise.allSettled(
    selectedIds.map(async (id) => {
      const { fn, label } = SCRAPERS[id];
      log(`Scraping ${label}...`);
      const t = Date.now();
      // Retry the whole scraper on failure so a transient outage/rate-limit gets a
      // few attempts with backoff — a uniform guarantee regardless of whether the
      // scraper's internals self-retry (fetch.ts) or not (Playwright/curl paths).
      // Each attempt is time-boxed so a hung venue times out (and retries, then
      // fails cleanly) instead of stalling the whole run.
      const films = await withRetry(() => withTimeout(fn(), SCRAPER_TIMEOUT_MS, label), { label });
      log(`  ${label}: ${films.length} films (${((Date.now() - t) / 1000).toFixed(1)}s)`);
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
      log(`✗ ${SCRAPERS[selectedIds[i]].label} failed: ${result.reason}`);
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
  log(`  ${rawFilms.length} unique films after merge`);

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
  log(`  ${windowedFilms.length} films within ${start} → ${end}`);

  log("Enriching via TMDB...");
  // Enrichment only adds metadata; it leaves showtimes (already windowed) intact.
  const { films, failures } = await enrichFilms(windowedFilms, {
    force,
    retryTitles,
    cache,
  });

  saveCache(cache);

  const schedule: Schedule = {
    generated_at: new Date().toISOString(),
    generator: VERSION,
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
      {
        id: "st-johns",
        name: "St. Johns Twin Cinema & Pub",
        neighborhood: "N Portland / St. Johns",
        address: "8704 N Lombard St, Portland OR",
        lat: 45.5944,
        lng: -122.7457,
        website: "https://www.saintjohnspub.net",
        group: null,
      },
      {
        id: "moreland",
        name: "Moreland Theater",
        neighborhood: "SE Portland / Sellwood",
        address: "6712 SE Milwaukie Ave, Portland OR",
        lat: 45.4752,
        lng: -122.6504,
        website: "https://morelandtheater.com",
        group: null,
      },
      {
        id: "tomorrow",
        name: "Tomorrow Theater",
        neighborhood: "Downtown / Pearl District",
        address: "1219 SW Park Ave, Portland OR",
        lat: 45.5158,
        lng: -122.6831,
        website: "https://tomorrowtheater.org",
        group: null,
      },
      {
        id: "mission",
        name: "Mission Theater",
        neighborhood: "NW Portland",
        address: "1624 NW Glisan St, Portland OR",
        lat: 45.5255,
        lng: -122.6933,
        website: "https://www.mcmenamins.com/mission-theater",
        group: "McMenamins",
      },
      {
        id: "avalon",
        name: "Avalon Theatre",
        neighborhood: "SE Portland / Belmont",
        address: "3451 SE Belmont St, Portland OR",
        lat: 45.5150,
        lng: -122.6288,
        website: "https://wunderlandgames.com/movies/avalon/",
        group: "Wunderland Games",
      },
    ],
    films,
  };

  mkdirSync("public/data", { recursive: true });
  writeFileSync("public/data/showtimes.json", JSON.stringify(schedule, null, 2));
  log(`\nWrote public/data/showtimes.json`);
  log(`  ${films.length} films, ${films.flatMap((f) => f.showtimes).length} showtimes`);
  log(`  Window: ${start} → ${end}`);

  if (failedScrapers.length > 0) {
    const labels = failedScrapers.map(id => SCRAPERS[id].label).join(", ");
    console.warn(`\n⚠  Degraded run: ${failedScrapers.length} scraper(s) failed (${labels}).`);
    console.warn(`   Preserved last-known-good showtimes for those venues.`);
    log(`\n⚠  Degraded run: ${failedScrapers.length} scraper(s) failed (${labels}).`);
    log(`   Preserved last-known-good showtimes for those venues.`);
  }

  if (failures.length > 0) {
    writeFileSync("public/data/failed-matches.json", JSON.stringify(failures, null, 2));
    log(`\n⚠  ${failures.length} film(s) could not be matched to TMDB:`);
    for (const f of failures) {
      log(`   • "${f.title}" (${f.runtime_minutes ?? "?"}min) — ${f.venue_id}`);
    }
    log(`\n   Fix: add entries to TMDB_ID_OVERRIDES in src/enrich.ts`);
    log(`   Details written to public/data/failed-matches.json`);
  } else {
    log("\nAll films matched successfully.");
  }

  log(`=== Run finished: ${new Date().toISOString()} (${((Date.now() - runStart.getTime()) / 1000).toFixed(1)}s) ===\n`);
}

// Overall hard deadline. Even if a scraper, browser teardown, or a dangling
// handle wedges, the process must end — otherwise a hung run burns the full
// 6h GitHub Actions job timeout. Fires only as a last resort; healthy runs
// (~1min) exit long before this. unref() so the watchdog itself never keeps
// the process alive on the happy path.
const OVERALL_DEADLINE_MS = 8 * 60_000;
setTimeout(() => {
  console.error(`Scrape exceeded ${OVERALL_DEADLINE_MS / 60_000}min overall deadline — forcing exit.`);
  process.exit(1);
}, OVERALL_DEADLINE_MS).unref();

main()
  // Exit explicitly on success. The scrape is a batch job: once the files are
  // written its work is done. Lingering handles (Playwright subprocess, undici
  // keep-alive sockets, a curl child) would otherwise keep the event loop alive
  // and hang the process idle until the CI job timeout — the 6h "timeout" we saw.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
