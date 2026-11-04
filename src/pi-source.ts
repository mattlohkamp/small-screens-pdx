// Reads a venue's raw scrape output from the `pi-data` branch — the pi-scraper host (a machine on a
// residential connection) pushes there directly for venues CI's datacenter IP gets blocked on
// (see PLAN.md, "Residential scraping"). This is a plain HTTPS GET of one committed file; CI never
// clones or pulls that branch's history, only fetches this one JSON blob.
import { fileURLToPath } from "url";
import { fetchJson } from "./fetch.js";
import { piCodeHash } from "../pi-scraper/src/code-hash.js";
import type { Film } from "./types.js";

const RAW_BASE = "https://raw.githubusercontent.com/mattlohkamp/small-screens-pdx/pi-data/data/raw";

// The pi-scraper host's cron runs three times a day; give it slack for a missed/late run before we stop trusting
// its data and fall through to the orchestrator's own last-known-good preservation.
const MAX_AGE_HOURS = 36;

interface PiRawFile {
  venue_ids: string[];
  scraped_at: string;
  code_hash?: string; // absent from files written before the host stamped them
  films: Film[];
}

// Hash of pi-scraper/ in this checkout: what the host *should* be running.
export const EXPECTED_PI_CODE_HASH = piCodeHash(fileURLToPath(new URL("../pi-scraper/", import.meta.url)));

// code_hash seen per venue this process, for the stale-code health check.
export const piCodeHashes = new Map<string, string | null>();

export async function fetchPiRaw(venueId: string): Promise<Film[]> {
  const data = await fetchJson<PiRawFile>(`${RAW_BASE}/${venueId}.json`, {}, `pi-data/${venueId}`);
  piCodeHashes.set(venueId, data.code_hash ?? null);
  const ageHours = (Date.now() - new Date(data.scraped_at).getTime()) / 36e5;
  if (ageHours > MAX_AGE_HOURS) {
    throw new Error(`pi-data/${venueId}.json is ${ageHours.toFixed(1)}h old (max ${MAX_AGE_HOURS}h) — treating as stale`);
  }
  return data.films;
}
