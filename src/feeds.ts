// Subscribable feeds built from each canonical scrape, published next to the site:
//
//   feeds/all.ics           every showtime in the 7-day window, all venues
//   feeds/<venue-id>.ics    one calendar per venue (subscribe to "your" theater)
//   feeds/new.xml           RSS: films as they first show up anywhere
//
// Calendars hold only the current window, so a subscribed calendar shows what's
// on now and past showtimes drop off as the window rolls forward. RSS needs to
// know when each film first appeared, which lives in state/feed-state.json
// (committed by CI alongside the health state).
//
// Output is deterministic for unchanged input (no "generated now" stamps inside
// events) so git only sees real changes between runs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Film, Schedule, Showtime, Venue } from "./types.js";

export const SITE_URL = "https://mattlohkamp.github.io/small-screens-pdx/";
export const FEEDS_DIR = "public/feeds";
export const FEED_STATE_PATH = "state/feed-state.json";
const TZ = "America/Los_Angeles";
const DEFAULT_RUNTIME_MIN = 120;
// Forget a film this long after it was last listed, so a later revival counts
// as new again instead of resurfacing under its old first-seen date.
const FORGET_AFTER_DAYS = 60;
const RSS_MAX_ITEMS = 60;

// ---------- first-seen state ----------

interface SeenFilm {
  title: string;
  first_seen: string; // ISO
  last_seen: string; // ISO
}

export interface FeedState {
  version: 1;
  films: Record<string, SeenFilm>;
}

export function filmKey(f: Film): string {
  return f.id !== null ? `tmdb-${f.id}` : `title-${f.slug}`;
}

export function loadFeedState(path = FEED_STATE_PATH): FeedState {
  if (!existsSync(path)) return { version: 1, films: {} };
  return JSON.parse(readFileSync(path, "utf8")) as FeedState;
}

export function saveFeedState(state: FeedState, path = FEED_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

// Pure: records which films are listed now and forgets long-gone ones.
export function updateFeedState(prev: FeedState, films: Film[], now: string): FeedState {
  const state: FeedState = structuredClone(prev);
  for (const f of films) {
    const key = filmKey(f);
    const seen = state.films[key];
    state.films[key] = seen ? { ...seen, title: f.title, last_seen: now } : { title: f.title, first_seen: now, last_seen: now };
  }
  const cutoff = Date.parse(now) - FORGET_AFTER_DAYS * 86_400_000;
  for (const [key, seen] of Object.entries(state.films)) {
    if (Date.parse(seen.last_seen) < cutoff) delete state.films[key];
  }
  return state;
}

// ---------- time helpers ----------

// "2026-11-05T19:00:00" Portland wall time → UTC Date. Two passes handle the
// DST offset (the offset depends on the instant we're solving for).
export function pacificToUtc(local: string): Date {
  const [d, t] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const asWall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    guess += wall - asWall;
  }
  return new Date(guess);
}

const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function shortDay(local: string): string {
  return new Date(`${local.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
  });
}

function shortTime(local: string): string {
  const [h, m] = local.slice(11, 16).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

// ---------- iCalendar ----------

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// RFC 5545: lines over 75 octets fold onto continuation lines starting with a space.
function icsFold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines spend one octet on the leading space
  }
  return out.join("\r\n ");
}

function filmLabel(f: Film): string {
  return f.year ? `${f.title} (${f.year})` : f.title;
}

function eventLines(f: Film, s: Showtime, venue: Venue, stamp: string): string[] {
  const start = pacificToUtc(s.datetime);
  const end = new Date(start.getTime() + (f.runtime_minutes ?? DEFAULT_RUNTIME_MIN) * 60_000);
  const details = [
    [f.director && `Dir. ${f.director}`, f.runtime_minutes && `${f.runtime_minutes} min`].filter(Boolean).join(" · "),
    s.format && s.format.toUpperCase() !== "DCP" ? `Format: ${s.format}` : "",
    s.event_note ? `Special showing: ${s.event_note}` : "",
    f.overview ?? "",
    s.ticket_url ? `Tickets: ${s.ticket_url}` : "",
    `More showtimes: ${SITE_URL}`,
  ].filter(Boolean);
  return [
    "BEGIN:VEVENT",
    `UID:${s.venue_id}-${s.datetime.replace(/[-:]/g, "")}-${f.slug}@small-screens-pdx`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsEscape(filmLabel(f))}`,
    `LOCATION:${icsEscape(`${venue.name}, ${venue.address}`)}`,
    `GEO:${venue.lat};${venue.lng}`,
    `DESCRIPTION:${icsEscape(details.join("\n\n"))}`,
    `URL:${s.ticket_url ?? venue.website}`,
    "END:VEVENT",
  ];
}

export function buildIcs(schedule: Schedule, venueIds: Set<string> | null, name: string, state: FeedState): string {
  const venues = new Map(schedule.venues.map((v) => [v.id, v]));
  const events: { sortKey: string; lines: string[] }[] = [];
  for (const f of schedule.films) {
    // DTSTAMP must exist; use when the film first appeared so it's stable run to run.
    const firstSeen = state.films[filmKey(f)]?.first_seen ?? schedule.generated_at;
    const stamp = icsTime(new Date(firstSeen));
    for (const s of f.showtimes) {
      const venue = venues.get(s.venue_id);
      if (!venue || (venueIds && !venueIds.has(s.venue_id))) continue;
      events.push({ sortKey: `${s.datetime}|${s.venue_id}|${f.slug}`, lines: eventLines(f, s, venue, stamp) });
    }
  }
  events.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//small-screens-pdx//showtimes//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(name)}`,
    `X-WR-CALDESC:${icsEscape(`Independent cinema showtimes from ${SITE_URL}`)}`,
    `X-WR-TIMEZONE:${TZ}`,
    // Ask subscribing apps to re-fetch a few times a day, matching the scrape cadence.
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    ...events.flatMap((e) => e.lines),
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// ---------- RSS ----------

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function itemHtml(f: Film, venues: Map<string, Venue>): string {
  const byVenue = new Map<string, Showtime[]>();
  for (const s of [...f.showtimes].sort((a, b) => (a.datetime < b.datetime ? -1 : 1))) {
    byVenue.set(s.venue_id, [...(byVenue.get(s.venue_id) ?? []), s]);
  }
  const meta = [f.director && `Dir. ${f.director}`, f.runtime_minutes && `${f.runtime_minutes} min`, f.genres.join(", ")]
    .filter(Boolean).join(" · ");
  const rows = [...byVenue].map(([venueId, times]) => {
    const name = venues.get(venueId)?.name ?? venueId;
    const days = new Map<string, string[]>();
    for (const s of times) days.set(shortDay(s.datetime), [...(days.get(shortDay(s.datetime)) ?? []), shortTime(s.datetime)]);
    const when = [...days].map(([d, ts]) => `${d}: ${ts.join(", ")}`).join("; ");
    return `<li><strong>${xmlEscape(name)}</strong> — ${xmlEscape(when)}</li>`;
  });
  return [
    f.poster_path ? `<p><img src="https://image.tmdb.org/t/p/w342${f.poster_path}" alt="" width="171"/></p>` : "",
    meta ? `<p>${xmlEscape(meta)}</p>` : "",
    f.overview ? `<p>${xmlEscape(f.overview)}</p>` : "",
    `<ul>${rows.join("")}</ul>`,
    `<p><a href="${SITE_URL}">All showtimes on Small Screens PDX</a></p>`,
  ].filter(Boolean).join("");
}

export function buildRss(schedule: Schedule, state: FeedState): string {
  const venues = new Map(schedule.venues.map((v) => [v.id, v]));
  const items = schedule.films
    .map((f) => ({ f, seen: state.films[filmKey(f)] }))
    .filter((x) => x.seen)
    .sort((a, b) => (a.seen.first_seen > b.seen.first_seen ? -1 : a.seen.first_seen < b.seen.first_seen ? 1 : a.f.title.localeCompare(b.f.title)))
    .slice(0, RSS_MAX_ITEMS);
  const newest = items[0]?.seen.first_seen ?? schedule.generated_at;
  const body = items.map(({ f, seen }) => {
    const venueNames = [...new Set(f.showtimes.map((s) => venues.get(s.venue_id)?.name ?? s.venue_id))];
    return [
      "    <item>",
      `      <title>${xmlEscape(`${filmLabel(f)} at ${venueNames.join(", ")}`)}</title>`,
      `      <link>${SITE_URL}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(`${filmKey(f)}@${seen.first_seen.slice(0, 10)}`)}</guid>`,
      `      <pubDate>${new Date(seen.first_seen).toUTCString()}</pubDate>`,
      `      <description><![CDATA[${itemHtml(f, venues).replace(/]]>/g, "]]]]><![CDATA[>")}]]></description>`,
      "    </item>",
    ].join("\n");
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    "  <channel>",
    "    <title>Small Screens PDX: newly showing</title>",
    `    <link>${SITE_URL}</link>`,
    `    <atom:link href="${SITE_URL}feeds/new.xml" rel="self" type="application/rss+xml"/>`,
    "    <description>Films as they first appear on Portland's independent cinema schedules.</description>",
    "    <language>en-us</language>",
    "    <ttl>360</ttl>",
    `    <lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>`,
    ...body,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

// ---------- write everything ----------

export function writeFeeds(schedule: Schedule, state: FeedState, dir = FEEDS_DIR): string[] {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const put = (file: string, content: string) => {
    writeFileSync(join(dir, file), content);
    written.push(file);
  };
  put("all.ics", buildIcs(schedule, null, "Small Screens PDX: all venues", state));
  for (const v of schedule.venues) put(`${v.id}.ics`, buildIcs(schedule, new Set([v.id]), `Small Screens PDX: ${v.name}`, state));
  put("new.xml", buildRss(schedule, state));
  return written;
}
