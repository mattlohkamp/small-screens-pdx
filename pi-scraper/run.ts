// Entry point for natty (residential Pi/media server). Runs only the two
// scrapers that GitHub Actions' datacenter IP gets blocked on, and writes
// each venue's raw output to the sibling push-only data checkout
// (../small-screens-data, on the pi-data branch) — never touches the main
// small-screens-pdx repo or its git history. See PLAN.md's M7 section for
// the reasoning behind splitting this out.
import { writeFileSync, mkdirSync } from "fs";
import { scrapeHollywood } from "./src/scrapers/hollywood.js";
import { scrapeOmsi } from "./src/scrapers/omsi.js";
import { closeBrowser } from "./src/browser.js";

const DATA_DIR = process.env.PI_DATA_DIR ?? "../small-screens-data/data/raw";

async function scrapeOne(name: string, fn: () => Promise<unknown>) {
  try {
    const films = await fn();
    writeFileSync(
      `${DATA_DIR}/${name}.json`,
      JSON.stringify({ venue_ids: [name], scraped_at: new Date().toISOString(), films }, null, 2),
    );
    console.log(`${name}: wrote ${(films as unknown[]).length} films`);
  } catch (err) {
    // Leave the existing file untouched on failure rather than overwrite
    // good data with nothing — same "fail loud" principle as the main scraper.
    console.error(`${name} scrape failed, leaving last-known-good file in place:`, err);
  }
}

mkdirSync(DATA_DIR, { recursive: true });
await scrapeOne("hollywood", scrapeHollywood);
await scrapeOne("omsi", scrapeOmsi);
await closeBrowser();
