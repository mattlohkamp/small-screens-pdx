// Reads a venue's raw scrape output from the `pi-data` branch — natty (a residential
// Pi/media server) pushes there directly for venues CI's datacenter IP gets blocked on
// (see PLAN.md's M7 section). This is a plain HTTPS GET of one committed file; CI never
// clones or pulls that branch's history, only fetches this one JSON blob.
import { fetchJson } from "./fetch.js";
import type { Film } from "./types.js";

const RAW_BASE = "https://raw.githubusercontent.com/mattlohkamp/small-screens-pdx/pi-data/data/raw";

// natty's cron runs daily; give it slack for a missed/late run before we stop trusting
// its data and fall through to the orchestrator's own last-known-good preservation.
const MAX_AGE_HOURS = 36;

interface PiRawFile {
  venue_ids: string[];
  scraped_at: string;
  films: Film[];
}

export async function fetchPiRaw(venueId: string): Promise<Film[]> {
  const data = await fetchJson<PiRawFile>(`${RAW_BASE}/${venueId}.json`, {}, `pi-data/${venueId}`);
  const ageHours = (Date.now() - new Date(data.scraped_at).getTime()) / 36e5;
  if (ageHours > MAX_AGE_HOURS) {
    throw new Error(`pi-data/${venueId}.json is ${ageHours.toFixed(1)}h old (max ${MAX_AGE_HOURS}h) — treating as stale`);
  }
  return data.films;
}
