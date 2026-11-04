// Per-venue scrape health: detects (1) scrapers that keep failing and (2) venues
// that are normally busy but suddenly have an empty week, and pushes a phone
// notification via ntfy when a problem starts or clears.
//
// Why this exists: scrape.ts deliberately hides single-venue failures (it keeps
// last-known-good showtimes so the site stays intact), and a scraper can
// "succeed" while returning nothing — Cinemagic silently returned 0 showtimes
// for a week in Oct 2026 after a site redesign. Neither failed the CI job.
//
// "Unusually empty" is judged against the venue's own recent history, so venues
// that only screen occasionally (Mission Theater: ~1 film in four months) never
// alert on an empty week.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export const HEALTH_PATH = "state/venue-health.json";

// How many days of history to keep, and how many of them must have had
// showtimes for a venue to count as "usually populated".
export const HISTORY_DAYS = 14;
export const MIN_POPULATED_DAYS = 10;
// Consecutive failed runs before alerting. Scrapers already retry 3x within a
// run, so 2 failed runs (~8–16h at 3 runs/day) means it's not a blip.
export const FAILURES_BEFORE_ALERT = 2;

export type RunStatus = "ok" | "failed";

interface DayRecord {
  // Showtimes in the scrape window on the latest successful run that day.
  // null = no successful run that day (failed runs don't overwrite a count,
  // since the schedule then holds preserved last-known-good data).
  showtimes: number | null;
  status: RunStatus;
}

interface VenueHealth {
  days: Record<string, DayRecord>; // keyed by Portland date "YYYY-MM-DD"
  consecutive_failures: number;
  alerting: { failing: boolean; empty: boolean };
}

export interface HealthState {
  version: 1;
  venues: Record<string, VenueHealth>;
  // Whether we're currently alerting that the pi-scraper host runs stale code.
  pi_code?: { alerting: boolean };
}

export interface VenueRunResult {
  venueId: string;
  label: string;
  status: RunStatus;
  showtimes: number;
  error?: string;
}

export interface HealthEvent {
  venueId: string;
  label: string;
  kind: "failing" | "empty" | "stale_code";
  change: "started" | "recovered";
  detail: string;
}

export function loadHealth(path = HEALTH_PATH): HealthState {
  if (!existsSync(path)) return { version: 1, venues: {} };
  return JSON.parse(readFileSync(path, "utf8")) as HealthState;
}

export function saveHealth(state: HealthState, path = HEALTH_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Days (before today) with a known count, and how many of those had showtimes.
function priorHistory(venue: VenueHealth, today: string) {
  const earliest = addDays(today, -HISTORY_DAYS);
  const counts = Object.entries(venue.days)
    .filter(([day, rec]) => day < today && day >= earliest && rec.showtimes != null)
    .map(([, rec]) => rec.showtimes!);
  const populated = counts.filter((n) => n > 0);
  const typical = populated.length
    ? Math.round([...populated].sort((a, b) => a - b)[Math.floor(populated.length / 2)])
    : 0;
  return { populatedDays: populated.length, typical };
}

// Pure: folds this run's results into the state and returns what changed.
export function evaluateHealth(
  prev: HealthState,
  results: VenueRunResult[],
  today: string,
): { state: HealthState; events: HealthEvent[] } {
  const state: HealthState = structuredClone(prev);
  const events: HealthEvent[] = [];
  const earliest = addDays(today, -HISTORY_DAYS);

  for (const r of results) {
    const venue: VenueHealth = (state.venues[r.venueId] ??= {
      days: {},
      consecutive_failures: 0,
      alerting: { failing: false, empty: false },
    });

    // Judge emptiness against history *before* recording today.
    const { populatedDays, typical } = priorHistory(venue, today);

    const existing = venue.days[today];
    venue.days[today] =
      r.status === "ok"
        ? { showtimes: r.showtimes, status: "ok" }
        : { showtimes: existing?.showtimes ?? null, status: "failed" };
    for (const day of Object.keys(venue.days)) {
      if (day < earliest) delete venue.days[day];
    }

    venue.consecutive_failures = r.status === "failed" ? venue.consecutive_failures + 1 : 0;

    // (1) Failing: N consecutive failed runs.
    const failing = venue.consecutive_failures >= FAILURES_BEFORE_ALERT;
    if (failing && !venue.alerting.failing) {
      events.push({
        venueId: r.venueId, label: r.label, kind: "failing", change: "started",
        detail: `scraper failed ${venue.consecutive_failures} runs in a row${r.error ? `: ${r.error}` : ""}`,
      });
    } else if (!failing && venue.alerting.failing) {
      events.push({
        venueId: r.venueId, label: r.label, kind: "failing", change: "recovered",
        detail: "scraper is working again",
      });
    }
    venue.alerting.failing = failing;

    // (2) Unusually empty: a successful run found nothing, for a venue that had
    // showtimes on most recent days. A failed run can't confirm or clear this.
    if (r.status === "ok") {
      const usuallyPopulated = populatedDays >= MIN_POPULATED_DAYS;
      const empty = r.showtimes === 0 && usuallyPopulated;
      if (empty && !venue.alerting.empty) {
        events.push({
          venueId: r.venueId, label: r.label, kind: "empty", change: "started",
          detail: `0 showtimes this week; had showtimes on ${populatedDays} of the last ${HISTORY_DAYS} days (typically ~${typical})`,
        });
      } else if (venue.alerting.empty && r.showtimes > 0) {
        events.push({
          venueId: r.venueId, label: r.label, kind: "empty", change: "recovered",
          detail: `showtimes are back (${r.showtimes} this week)`,
        });
      }
      venue.alerting.empty = empty || (venue.alerting.empty && r.showtimes === 0);
    }
  }

  return { state, events };
}

// The pi-scraper host gets code by hand (scp), so it can silently keep running an
// old copy. Each raw file it pushes carries a hash of the code that wrote it;
// compare with the hash of pi-scraper/ in this checkout. `observed` holds the
// hashes from this run's pi-data reads (null = file predates hashing). No reads
// this run (e.g. pi-data unreachable) means no evidence, so nothing changes.
// Mutates `state.pi_code`; returns the start/clear event, if any.
export function evaluatePiCode(
  state: HealthState,
  observed: (string | null)[],
  expected: string,
): HealthEvent[] {
  if (observed.length === 0) return [];
  const wasAlerting = state.pi_code?.alerting ?? false;
  const stale = observed.some((h) => h !== expected);
  state.pi_code = { alerting: stale };
  const base = { venueId: "pi-scraper", label: "pi-scraper host", kind: "stale_code" as const };
  if (stale && !wasAlerting) {
    const seen = [...new Set(observed.map((h) => h ?? "none"))].join(", ");
    return [{
      ...base, change: "started",
      detail: `running code ${seen}, repo has ${expected}. Copy pi-scraper/ over and run npm ci there.`,
    }];
  }
  if (!stale && wasAlerting) {
    return [{ ...base, change: "recovered", detail: `running current code (${expected})` }];
  }
  return [];
}

// Push severity tiers, mapped to ntfy priorities (1 min … 5 urgent). The
// phone app vibrates/pops over differently per priority, and each can be
// tuned in the app. Whole-run failure (priority 5) is sent from the workflow's
// failure step in scrape.yml, since this code never runs in that case.
interface Tier {
  match: (e: HealthEvent) => boolean;
  priority: 2 | 3 | 4;
  tags: string; // ntfy emoji shortcodes; first one shows beside the title
  title: (n: number) => string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const TIERS: Tier[] = [
  {
    // Alert: a scraper is actually broken (errors / can't reach its data).
    match: (e) => e.kind === "failing" && e.change === "started",
    priority: 4,
    tags: "rotating_light,film_projector",
    title: (n) => `small screens ALERT: ${plural(n, "scraper")} failing`,
  },
  {
    // Warning: scraper runs, but a usually-busy venue came back empty.
    match: (e) => e.kind === "empty" && e.change === "started",
    priority: 3,
    tags: "warning,film_projector",
    title: (n) => `small screens warning: ${plural(n, "venue")} unexpectedly empty`,
  },
  {
    // Warning: the pi-scraper host is running an out-of-date copy of pi-scraper/.
    match: (e) => e.kind === "stale_code" && e.change === "started",
    priority: 3,
    tags: "wrench,film_projector",
    title: () => "small screens warning: pi-scraper host running old code",
  },
  {
    // Recovery: quiet good news.
    match: (e) => e.change === "recovered",
    priority: 2,
    tags: "white_check_mark,film_projector",
    title: (n) => `small screens: ${plural(n, "issue")} resolved`,
  },
];

// One push per severity tier that has changes this run; silent otherwise.
// Never throws — a notification problem must not fail the scrape.
export async function notifyHealth(events: HealthEvent[], log: (msg: string) => void): Promise<void> {
  if (events.length === 0) return;

  const line = (e: HealthEvent) => `${e.change === "recovered" ? "✓" : "⚠"} ${e.label}: ${e.detail}`;
  for (const e of events) log(`  health: ${line(e)}`);

  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    log("  health: NTFY_TOPIC not set — skipping push notification");
    return;
  }
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const runUrl = GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;

  // The ntfy app only shows relative arrival times ("yesterday"), so stamp
  // each push with the exact Pacific time, e.g. "Wed, Nov 4, 10:42 AM PST".
  const stamp = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  for (const tier of TIERS) {
    const tierEvents = events.filter(tier.match);
    if (tierEvents.length === 0) continue;
    try {
      const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: {
          // HTTP headers must be ASCII/Latin-1, so keep the title plain.
          Title: tier.title(tierEvents.length),
          Priority: String(tier.priority),
          Tags: tier.tags,
          ...(runUrl ? { Click: runUrl } : {}),
        },
        body: [stamp, ...tierEvents.map(line)].join("\n"),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) log(`  health: ntfy responded HTTP ${res.status} (priority ${tier.priority})`);
      else log(`  health: sent priority-${tier.priority} push (${plural(tierEvents.length, "change")})`);
    } catch (err) {
      log(`  health: failed to send priority-${tier.priority} push: ${err}`);
    }
  }
}
