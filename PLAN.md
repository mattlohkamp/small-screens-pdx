# Small Screens PDX — Project Plan

## Overview

A website that aggregates showtimes from Portland's independent cinemas into a single, unified view. Each theater publishes its own schedule on its own site; this project scrapes them, enriches the data via TMDB, and presents it in one place — searchable, filterable, and browsable by film, venue, date, and format.

**Target audience:** Portlanders who care about independent cinema and want to know what's playing across all the small screens this week — without checking five different websites.

---

## Target Venues

Portland proper only — no Vancouver WA, Beaverton, or Clackamas.

| Venue | Neighborhood | Group | Screens | URL | Rendering | Ticketing |
|---|---|---|---|---|---|---|
| Cinema 21 | NW / Alphabet District | — | 1 | cinema21.com | SPA / unknown | Unknown |
| Hollywood Theatre | NE Portland | — | 1 | hollywoodtheatre.org | Unknown | Unknown (blocks scrapers) |
| Living Room Theaters | Downtown | — | 6 | livingroomtheaters.com | JS-rendered | Unknown |
| Laurelhurst Theater | NE Portland | — | 4 | laurelhursttheater.com | Server-rendered (partial) | Custom |
| Academy Theater | SE / Montavilla | — | 2 | academytheaterpdx.com | JS-rendered | Webedia CMS |
| Whitsell Auditorium (PAM CUT) | Downtown | — | 1 | portlandartmuseum.org | Server-rendered | Unknown |
| Clinton Street Theater | SE Portland | — | 1 | cstpdx.com | **Server-rendered ✓** | Square + Eventive |
| Cinemagic | SE Portland | — | 1 | tickets.thecinemagictheater.com | **Server-rendered ✓** | Custom subdomain |
| Baghdad Theater | SE Portland | McMenamins | 1 | mcmenamins.com/bagdad-theater-pub | **Server-rendered ✓** | **Veezi API** |
| Kennedy School Theater | NE Portland | McMenamins | 1 | mcmenamins.com/kennedy-school-theater | **Server-rendered ✓** | **Veezi API** |
| Mission Theater | NW Portland | McMenamins | 1 | mcmenamins.com/mission-theater | — | — |
| OMSI Empirical Theatre | SE Portland | — | 1 | omsi.edu/exhibits/empirical-theater/ | JS-rendered (Playwright) | Eventbrite white-label (tickets.omsi.edu) |

> **Mission Theater note:** Primarily a live events/music venue. No regular film screenings confirmed — likely out of scope.

> **OMSI Empirical Theatre note:** Mixed programming — nature docs, IMAX-style films, and real theatrical releases (e.g. *Project Hail Mary*, *Disclosure Day*). Non-film content (e.g. "World-Class Soccer 2026", category "Matches at the Museum") should be filtered out.
>
> Two-step scrape strategy:
> 1. **Cheerio** on `https://omsi.edu/exhibits/empirical-theater/` — server-rendered HTML listing all current/upcoming films with today's showtimes and `tickets.omsi.edu/events/[uuid]` links per film.
> 2. **Playwright** on each `tickets.omsi.edu/events/[uuid]` — JS-rendered (Eventbrite white-label), needed to get the full multi-date showtime schedule.
>
> Alternative discovery path (both JS-rendered, Playwright required):
> - `https://tickets.omsi.edu/events?category=Feature%20Films`
> - `https://tickets.omsi.edu/events?category=Documentary%20Films`
>
> venue_id: `omsi`.

> **McMenamins note:** Baghdad and Kennedy School both use the Veezi ticketing platform, which has a public REST API (`api.us.veezi.com`). Site token is embedded in ticket purchase URLs. One integration covers both venues.

**Estimated total: ~19 screens across 10 film venues.**

---

## Data Model

**Film is the primary entity.** Showtimes hang off films; venues are a lookup table.

### Runtime JSON structure

One file covers a rolling 2-week window. Generated fresh on each scrape run.

```json
{
  "generated_at": "2026-06-01T05:00:00Z",
  "window": { "start": "2026-06-01", "end": "2026-06-14" },
  "venues": [
    {
      "id": "cinema-21",
      "name": "Cinema 21",
      "neighborhood": "Alphabet District",
      "address": "616 NW 21st Ave, Portland OR",
      "lat": 45.5271,
      "lng": -122.6975,
      "website": "https://cinema21.com",
      "group": null
    }
  ],
  "films": [
    {
      "id": 508883,
      "slug": "the-substance-2024",
      "title": "The Substance",
      "year": 2024,
      "director": "Coralie Fargeat",
      "runtime_minutes": 140,
      "overview": "...",
      "poster_path": "/lqoMzCcZYEFK729d6qzt349fB4o.jpg",
      "genres": ["Horror", "Science Fiction"],
      "release_date": "2024-09-20",
      "showtimes": [
        {
          "venue_id": "cinema-21",
          "datetime": "2026-06-01T19:30:00",
          "format": "35mm",
          "ticket_url": "https://..."
        }
      ]
    }
  ]
}
```

### Key design decisions

- **Film identity:** TMDB integer ID is the canonical key. `slug` (title + year) is the URL-friendly alias.
- **Poster images:** Hotlinked from TMDB's CDN — `https://image.tmdb.org/t/p/w500/{poster_path}`. No local image storage.
- **Showtime format field:** Captures projection format where theaters provide it (35mm, 70mm, DCP, etc.).
- **Deduplication:** If two venues show the same film, it appears once in `films[]` with multiple entries in its `showtimes[]` array. Deduplication happens before enrichment — films are merged by title across scrapers, so TMDB is called once per unique film per run.
- **Enrichment cache:** Successful TMDB lookups are cached to `data/enrichment-cache.json` and reused across runs. Only new films and previous failures hit the API. Cache invalidation via TMDB's `/movie/changes` endpoint is a planned P1 improvement.

### Client-side query patterns

```ts
// All showtimes at a venue
films.flatMap(f =>
  f.showtimes
    .filter(s => s.venue_id === venueId)
    .map(s => ({ film: f, showtime: s }))
)

// All venues playing a film
venues.filter(v => film.showtimes.some(s => s.venue_id === v.id))

// What's playing on a given date
films.filter(f => f.showtimes.some(s => s.datetime.startsWith(date)))
```

---

## Scraping Strategy

Each venue site is different — one scraper per venue. High-level approach:

1. **Audit each site** — determine if the schedule is server-rendered HTML, client-side JS, or an embedded widget (Eventive, Veezi, etc.).
2. **Write a scraper per venue** — outputs raw showtime data normalized to our schema.
3. **TMDB enrichment step** — after scraping, look up each film by title against TMDB. Adds canonical ID, poster, overview, genres, runtime.
4. **Merge and write** — combine venue data and enriched film data into `upcoming.json`.
5. **Run on a schedule** — daily cron via GitHub Actions.

### Venue investigation workflow

For each new venue, we use a two-person approach before writing any code:

1. **Human:** Browse the site as a normal visitor — find the pages that actually show the schedule (the daily listings view, the "what's on" page, category filters, etc.) and share those URLs.
2. **Claude:** Investigate the underlying data layer — fetch those pages, look for JSON-LD, embedded JSON blobs, REST endpoints, GraphQL queries, third-party ticketing platform patterns, and any API calls the page makes.

Together this gives us a much better chance of finding a clean, stable data source rather than scraping fragile rendered HTML. The ideal outcome is an API call or data feed; the fallback is cheerio on server-rendered HTML; the last resort is Playwright on JS-rendered pages.

### Scraping tools

**Language: Node/TypeScript** throughout.

| Scenario | Tool |
|---|---|
| Server-rendered HTML | `cheerio` |
| JS-rendered pages | `playwright` |
| Veezi ticketing platform | Veezi REST API |

### TMDB enrichment

```
scraper extracts: "The Substance" (2024), Cinema 21, 2026-06-01 19:30
  → search TMDB: GET /search/movie?query=The+Substance
  → if multiple results: pick closest runtime match
  → fetch details: GET /movie/{id}?append_to_response=credits
  → returns: tmdb_id, canonical title, poster_path, overview, runtime, genres, director
  → merge into film record, cache result
```

TMDB API is free. Requires a free account + API key. Rate limit: 40 req/sec. Attribution required: "This product uses the TMDB API but is not endorsed or certified by TMDB."

**Failure handling:** If no TMDB match is found, the film is included as a provisional record (`id: null`) and logged to `public/data/failed-matches.json`. Manual fixes go into `TMDB_ID_OVERRIDES` in `src/enrich.ts`.

---

## Frontend

### Architecture

**React SPA** — a single `index.html` shell + JS bundle, served statically from NFSN. On load, fetches `upcoming.json` (~300KB estimated). All filtering, sorting, and searching happens client-side. No server required.

**Framework:** Next.js (static export) — `output: 'export'` produces flat files that deploy cleanly to NFSN via rsync.

### Views

**Primary (P0):**
- **What's on** — default view, today's showtimes across all venues. Filter by date (2-week window), venue, format, and group.
- **By film** — all venues and showtimes for a selected film.
- **By venue** — full schedule for a selected venue.

**View modes (P0):**
- List/table view — sortable, scannable
- Calendar/grid view — days as columns, films as rows or blocks

**Later (P1+):**
- Distance filtering (browser geolocation + venue lat/lng, client-side)
- Filter by format (35mm, 70mm, etc.)
- **Show/hide unmatched screenings** — Tomorrow Theater and similar mixed-programming venues include events that don't match TMDB (live panels, themed screenings with event suffixes). A toggle ("include unmatched events", default off) would let users see them. Candidate placement: alongside "hide past showtimes" or under "more filters".
- **Filter by new releases / first run** — use `release_date` from TMDB to surface films in their initial theatrical window (e.g., released within last 4 weeks). TMDB's top-level `release_date` field (US theatrical) is sufficient for this; `/movie/{id}/release_dates` gives a finer breakdown by release type if needed. Complements venue-type context: Academy and Laurelhurst are known second-run houses, so a new-releases filter naturally skews toward Living Room, Cinema 21, OMSI, etc.
- **Rotten Tomatoes ratings** — fetch RT score per film and store in `upcoming.json`. Enables "sort by RT score" in the frontend. RT doesn't have a public API; options: (1) scrape `rottentomatoes.com/m/{slug}` for the Tomatometer, (2) use a third-party wrapper, (3) use TMDB's `/movie/{id}/external_ids` to get IMDB id, then pull from OMDB API (has RT score field). OMDB is simplest — free tier, `omdbapi.com/?i={imdb_id}&apikey={key}` returns `tomatoScore`. Add `rt_score: number | null` to the `Film` type and enrich alongside TMDB.
- iCal / RSS feed
- Email/SMS alerts for specific films or directors
- Historical archive browsing

---

## Hosting & Deployment

**Host:** GitHub Pages — free static hosting, deploys via `actions/deploy-pages`. NearlyFreeSpeech.net kept as a documented alternative if needed.

**Pipeline:**

```
GitHub Actions cron (daily, ~5am Pacific)
  1. checkout repo
  2. npm run scrape (all scrapers run in parallel)
       → merge films across venues (dedup by title)
       → enrich via TMDB API (cache + retry failures)
       → write public/data/upcoming.json
  3. commit upcoming.json → push to main
       → triggers deploy workflow via paths filter

deploy workflow (on release-* tag OR push to main touching upcoming.json)
  1. npm run build
       → Next.js static export
       → outputs flat HTML/CSS/JS to /out/
  2. actions/deploy-pages → GitHub Pages
```

**Failure handling:** If any scraper throws, abort without overwriting `upcoming.json`. GitHub Pages continues serving the previous build.

---

## Milestones

- [x] **M0 — Audit:** All target venues assessed. Rendering approach, ticketing platform, and scrape strategy documented per venue.
- [x] **M1 — First scraper:** Cinemagic scraper complete. Outputs normalized JSON with titles, showtimes, and ticket URLs.
- [x] **M2 — TMDB integration:** Enrichment working. Film records include poster, overview, canonical TMDB ID, director, genres. Enrichment cache, failure queue, and `--force` flag in place.
- [x] **M3 — All scrapers:** Full `upcoming.json` generated locally from all venues. 51 films, 524 showtimes across 8 venues.
  - [x] Clinton Street Theater — The Events Calendar REST API (`/wp-json/tribe/events/v1/events`). Title normalization strips CST series labels ("Church of Film", "Cult Sensation:", Rocky Horror shadowcast suffixes). HTML entities decoded via cheerio.
  - [x] Laurelhurst Theater — `var gbl_movies` JSON blob embedded in homepage HTML. `dateTimeCMP` (YYYYMMDDHHMM 24h) parsed directly. "(open caption)" variants normalized and merged. Ticket URL constructed from `rtsSaleID_pk`.
  - [x] **McMenamins (Baghdad + Kennedy School)** — Scrapes `mcmenamins.com` venue pages (server-rendered HTML). Ticket URLs use Veezi ticketing (`ticketing.uswest.veezi.com`). One scraper covers both venues via `VENUES` array in `src/scrapers/mcmenamins.ts`. OCAP variants normalized and merged. Note: Veezi back-office REST API (`api.us.veezi.com`) requires a separate account token; the public `siteToken` in purchase URLs is for the consumer ticketing widget only and does not grant API access.
  - [x] **Academy Theater** — Webedia CMS REST API (`/api/gatsby-source-boxofficeapi/*`). No Playwright needed. Theater ID `X07OU`. Three endpoints: `scheduledMovies`, `schedule` (showtimes + ticket URLs per day), `movies` (details). Scraper at `src/scrapers/academy.ts`.
  - [x] **Living Room Theaters** — Playwright + GraphQL (`pdx.livingroomtheaters.com/graphql`). Portland site ID `317`, circuit ID `146`. Page load establishes session; custom headers (`site-id`, `circuit-id`, `client-type`) required for `showingsForDate` queries. Movies queried via intercepted response on page load; showings queried in parallel per date via `page.evaluate`. Ticket URLs constructed as `/purchase/{slug}?showingId={id}`. Scraper at `src/scrapers/living-room.ts`.
  - [x] **OMSI Empirical Theatre** — Cheerio on omsi.edu to extract event UUIDs; Eventbrite white-label REST API (`tickets.omsi.edu/cached_api`) for event details, calendar (available dates), and sessions (showtimes in UTC). No Playwright needed. Non-film categories filtered via `category` field in API response. `venue_id: omsi`.
  - [ ] Cinema 21 / Hollywood Theatre — block scrapers, approach TBD (out of scope for M3)
- [x] **M4 — Frontend v1:** What's on view with date picker, venue/genre filters, fuzzy search, compact/expanded modes, sort, Leaflet venue map, poster modal, IMDB links, ticket links. Deployed to GitHub Pages.
- [x] **M5 — Automated pipeline:** GitHub Actions cron running daily at 5am Pacific. Scrapers run in parallel. Scrape commits `upcoming.json` → triggers auto-deploy to GitHub Pages. Release tags (`release-X.Y.Z`) also trigger deploy.
- [ ] **M6 — Polish** (narrowed scope — calendar view and by-film/by-venue views dropped, already covered by existing filters):
  - [x] TMDB attribution (already in footer)
  - [x] Ratings — Rotten Tomatoes, IMDb, and Metacritic via OMDb API (keyed off the IMDb ID from TMDB enrichment). Badges per film, "Ratings unavailable" note when a matched film has none. Composite "Score" sort chip averages whichever ratings exist, normalizing IMDb to 0-100; unrated titles sort first rather than last.
  - [ ] Mobile layout polish — first pass done (responsive breakpoints for date cards, filter toggle row scroll-instead-of-wrap, showtime row stacking); another pass still planned
- [ ] **M7 — Distributed scrape architecture:** Decouple scrape from build so blocked venues (OMSI, Hollywood) can be scraped from a residential box while the rest run on CI. Per-source raw files; event-driven build. See "Distributed Scrape Architecture" below.

---

## Distributed Scrape Architecture (planned — M7)

### Problem

OMSI and Hollywood Theatre are **hard-blocked at GitHub Actions' datacenter IP** — their sites sit behind CloudFront WAFs that reject datacenter IPs by reputation. Confirmed on CI: no in-CI client trick beats it (Playwright, curl, and browser User-Agents all 403). From a **residential IP, plain `curl` returns 200** for both — verified end-to-end (OMSI details → calendar → sessions; Hollywood WP API). So the data is gettable; the request just has to originate from a residential connection.

That forces scraping to happen in **two places**: CI for the 11 working venues, and an always-on residential box (a Raspberry Pi fileserver) for OMSI + Hollywood. The current monolithic pipeline (`scrape → merge → enrich → upcoming.json` in one step) can't support two writers cleanly:
- Both would write the same `upcoming.json`, needing fragile "preserve the venues I didn't scrape" merge logic.
- **Silent data-loss bug:** a scraper that returns `0 films` on a block counts as success and *overwrites* good data. Failing loudly would preserve it; succeeding-empty destroys it. (Observed on CI: OMSI 403'd, returned 0 films, got wiped — and wasn't even flagged in the degraded-run summary.)

### Solution: decouple scrape from build, communicate via per-source files

Split the pipeline into two stages joined by committed per-source JSON files:

1. **scrape** — each scraper writes `data/raw/<scraper>.json` (raw `Film[]` + provenance). No enrichment, no `upcoming.json`.
2. **build** — reads *all* `data/raw/*.json`, merges/dedupes across venues, enriches via TMDB, writes `public/data/upcoming.json`, deploys.

Because CI and the Pi write **disjoint files**, they never conflict — git merges by path. The `data/raw/*.json` files become the committed **source-of-truth state**; `upcoming.json` becomes a **derived build artifact**.

### File layout

```
data/raw/
  cinemagic.json
  laurelhurst.json
  mcmenamins.json        # covers baghdad, kennedy-school, mission
  academy.json
  living-room.json
  clinton-street.json
  cinema-21.json
  st-johns.json
  moreland.json
  tomorrow.json
  omsi.json              # ← written by the Pi
  hollywood.json         # ← written by the Pi
public/data/
  upcoming.json          # ← built artifact, derived from raw/*
  enrichment-cache.json
  failed-matches.json
```

Raw file shape (one per scraper; a scraper may cover several venue_ids):

```json
{
  "venue_ids": ["omsi"],
  "generator": "1.1.0-<commithash>",
  "scraped_at": "2026-07-02T12:00:00Z",
  "films": [ { "title": "...", "year": null, "showtimes": [ ... ] } ]
}
```

### Entry points

- `npm run scrape [venues…]` — runs the selected scrapers, writes their raw files (default = all). No enrichment. Includes the reliability guards below.
- `npm run build` — assembles all raw files → merge → enrich → `upcoming.json`. Requires `TMDB_API_KEY`.

### Workflows

- **CI daily scrape** (cron, 5am Pacific): `npm run scrape <11 non-blocked venues>` → commit changed `data/raw/*.json` → push. (Drops OMSI/Hollywood — they'd only 403.)
- **Pi cron** (residential, always-on): `npm run scrape omsi hollywood` → commit `data/raw/{omsi,hollywood}.json` → push. **No TMDB key, no enrichment, no browser** (curl only).
- **build workflow** (event-driven): triggers on push to `data/raw/**` → `npm run build` → deploy to gh-pages. Single enrichment authority; *any* raw update — CI's or the Pi's — refreshes the live site with no added latency.

### What this removes / simplifies

- The "which venues did this run cover, preserve the rest" merge branch in `scrape.ts` → **gone**; raw files are the state.
- The **silent-wipe data-loss bug** → **gone**; a failed scrape simply doesn't rewrite its raw file, so the last good one stands.
- **Staleness self-heals** — a venue whose scraper stops running keeps its last raw file; its past showtimes age out of the window naturally.
- The **Pi needs no TMDB key and never enriches** — it only scrapes and commits raw.
- **OMSI → curl-based** (drop Playwright), so the Pi needs no chromium (ARM). Living Room keeps Playwright — it runs on CI and was never WAF-blocked.

### Reliability guards (fold into the `scrape` entry point regardless)

These fix issues observed on CI and apply to every venue, independent of the split:

- **Retry amplification** — the orchestrator retry (3×) currently nests over per-scraper retries (e.g. Hollywood's curl loop, 4×) = up to **12 attempts** against a permanent block, each with backoff → looks like a hang. Fix: make the **orchestrator the single retry authority**; remove per-scraper inner retry loops.
- **Per-scraper hard timeout** (~60s via `Promise.race`) so no venue can ever run away and stall the whole job.
- **Fail loud, not empty** — a total block **throws** (venue marked failed, raw file untouched) instead of returning `[]`.

### Migration sequence (when we build it)

1. Add `data/raw/`; change each scraper's runner to write its raw file. Add a temporary build that reads raw → produces `upcoming.json` so nothing breaks mid-migration.
2. Split `scrape.ts` into `scrape` (raw only) + `build.ts` (merge/enrich/assemble). Fold in the retry/timeout/fail-loud guards.
3. Add the event-driven build workflow on `data/raw/**`.
4. Refactor OMSI to curl; remove Playwright from it.
5. Update the CI daily scrape to the 11-venue list (drop omsi/hollywood).
6. Stand up the Pi cron: clone, `.env` (no TMDB key needed), deploy key, crontab entry — staggered off the 5am CI cron.

### Pi setup — info to gather when we build it

- Pi model / OS / CPU arch; Node version available (or install path).
- Git push method: deploy key (recommended, repo-scoped) vs PAT vs `gh` CLI.
- Scheduler: `crontab` vs `systemd` timer; preferred run time (stagger vs 5am CI).
- Confirm the Pi can reach `github.com` and the venue sites (omsi.edu, tickets.omsi.edu, hollywoodtheatre.org).
- Where the repo clone lives on the fileserver (disk is ample).

---

## Open Questions

1. ~~Any venues using Eventive or a shared ticketing platform?~~ Resolved: McMenamins Baghdad + Kennedy School use Veezi (has API). Clinton Street uses Eventive for some events.
2. ~~Hollywood Theatre and Cinema 21 block automated requests — scraping approach TBD.~~ Resolved: Cinema 21 scrapes fine on CI. Hollywood (and OMSI) are blocked only at datacenter IPs — to be scraped from a residential Pi under the M7 distributed architecture (see above).
3. Mission Theater — confirm no regular film screenings before dropping from scope.
