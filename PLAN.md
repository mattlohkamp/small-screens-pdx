# Small Screens PDX — Project Plan

## Overview

A website that aggregates showtimes from Portland's independent cinemas into a single, unified view. Each theater publishes its own schedule on its own site; this project scrapes them, enriches the data via TMDB, and presents it in one place — searchable, filterable, and browsable by film, venue, date, and format.

**Target audience:** Portlanders who care about independent cinema and want to know what's playing across all the small screens this week — without checking five different websites.

---

## Target Venues

Portland proper only — no Vancouver WA, Beaverton, or Clackamas.

| Venue | Neighborhood | Group | Screens | URL | Rendering | Ticketing |
|---|---|---|---|---|---|---|
| Cinema 21 | NW / Alphabet District | — | 1 | cinema21.com | **Server-rendered API ✓** | Custom (session API) |
| Hollywood Theatre | NE Portland | — | 1 | hollywoodtheatre.org | WordPress REST API, but **blocked in CI** (datacenter IP) | WordPress REST API |
| Living Room Theaters | Downtown | — | 6 | livingroomtheaters.com | JS-rendered (Playwright + GraphQL) | Custom (in-house purchase flow) |
| Laurelhurst Theater | NE Portland | — | 4 | laurelhursttheater.com | Server-rendered (partial) | Custom |
| Academy Theater | SE / Montavilla | — | 2 | academytheaterpdx.com | JS-rendered | Webedia CMS |
| Clinton Street Theater | SE Portland | — | 1 | cstpdx.com | **Server-rendered ✓** | Square + Eventive |
| Cinemagic | SE Portland | — | 1 | tickets.thecinemagictheater.com | **Server-rendered ✓** | Custom subdomain |
| Baghdad Theater | SE Portland | McMenamins | 1 | mcmenamins.com/bagdad-theater-pub | **Server-rendered ✓** | **Veezi API** |
| Kennedy School Theater | NE Portland | McMenamins | 1 | mcmenamins.com/kennedy-school-theater | **Server-rendered ✓** | **Veezi API** |
| Mission Theater | NW Portland | McMenamins | 1 | mcmenamins.com/mission-theater | **Server-rendered ✓** | McMenamins events page |
| OMSI Empirical Theatre | SE Portland | — | 1 | omsi.edu/exhibits/empirical-theater/ | JS-rendered (Playwright), but **blocked in CI** (datacenter IP) | Eventbrite white-label (tickets.omsi.edu) |
| Avalon Theatre | SE Portland / Belmont | Wunderland Games | 1 | wunderlandgames.com/movies/avalon/ | **Server-rendered API ✓** | Webedia CMS (boxofficeapi) |
| St. Johns Twin Cinema & Pub | N Portland / St. Johns | — | 1 | saintjohnspub.net | **Server-rendered ✓** (Cheerio on Veezi widget) | **Veezi** |
| Moreland Theater | SE Portland / Sellwood | — | 1 | morelandtheater.com | **Server-rendered API ✓** | FMT (formovietickets.com) |
| Tomorrow Theater | Downtown / Pearl District | — | 1 | tomorrowtheater.org | **Server-rendered API ✓** | Custom WP REST API |

> **Mission Theater note:** Uses the same McMenamins events page pattern as Baghdad/Kennedy School. Scraper live (`src/scrapers/mission.ts`); films confirmed (out of scope concern resolved).

> **Whitsell Auditorium (PAM CUT) note:** Never scraped — dropped from scope. No entry in the current venue registry.

> **Hollywood Theatre note:** Still unsolved as of 2026-07-23, and harder than OMSI's block. Cloudflare fronts the WP REST API with a **JS challenge (Turnstile)** — confirmed via the `cf-mitigated: challenge` response header — not a plain IP-reputation block. Tried, in order: (1) `curl` with a browser User-Agent — fails, curl can't execute the challenge JS at all. (2) Playwright issuing `fetch()` from inside a page via `page.evaluate` — fails, a bare `fetch()` just receives the 403 + challenge HTML as an inert body, never executing the embedded script. (3) Playwright doing a real `page.goto()` navigation to the API URL (so Chromium actually runs the challenge) — **still 403, on both a dev machine and natty's residential IP.** That last result rules out IP reputation as the variable (natty's IP already cleared OMSI's CloudFront block the same day) and points to Cloudflare fingerprinting Playwright's automation signals directly (e.g. `navigator.webdriver`, CDP protocol traces), regardless of origin. Next avenue, not yet tried: `patchright` (a Playwright/Chromium fork that patches the CDP-level tells regular "stealth" plugins miss) — real chance of working, but it's an arms race with no guarantee it stays working. Remains on the TODO list; not blocking the rest of M7, since OMSI, and the other 14 scrapers, all work.

> **Cinema 21 note:** Scrapes fine from CI — the "blocks scrapers" note in earlier drafts of this doc was wrong or based on an early attempt; see `src/scrapers/cinema-21.ts`.

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

> **Avalon Theatre note:** Same Webedia/Gatsby `boxofficeapi` platform as Academy Theater, hosted at `wcms-p-101180-114050d4.netlify.app`. Theater ID `X0430`. Three endpoints: `scheduledMovies`, `schedule` (showtimes per day), `movies` (details) — identical shape to Academy's integration. No ticket URLs available (the API's `ticketing` array is empty for this venue). Scraper at `src/scrapers/avalon.ts`. `venue_id: avalon`.

**Current total: 16 venues (14 scrapers — McMenamins covers Baghdad + Kennedy School in one, Mission separately) live in `src/scrape.ts`.**

---

## Data Model

**Film is the primary entity.** Showtimes hang off films; venues are a lookup table.

### Runtime JSON structure

One file, `public/data/showtimes.json`, covers a rolling **7-day window** (today + 6 days). Generated fresh on each scrape run.

```json
{
  "generated_at": "2026-06-01T05:00:00Z",
  "generator": "1.5.0-abc1234",
  "window": { "start": "2026-06-01", "end": "2026-06-07" },
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
      "imdb_id": "tt17526714",
      "rt_score": 89,
      "imdb_rating": 7.3,
      "metacritic_score": 78,
      "match_confidence": "verified",
      "showtimes": [
        {
          "venue_id": "cinema-21",
          "datetime": "2026-06-01T19:30:00",
          "format": "35mm",
          "ticket_url": "https://...",
          "event_note": null
        }
      ]
    }
  ]
}
```

Note: there is no `release_date` field — TMDB's release date isn't currently captured. The P1 "filter by new releases" idea below would need to add it.

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

**Next.js static export** (`output: 'export'`), deployed to GitHub Pages. On load, fetches `showtimes.json`. All filtering, sorting, and searching happens client-side. No server required.

### Views

A single unified `WhatsOn` view (`app/components/WhatsOn.tsx`) covers the whole product — date, venue, format, and group filters plus fuzzy search and sort replace the separate By-film/By-venue/calendar views originally planned here. See M6 below: those separate views were explicitly dropped as redundant once the filter set matured.

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

**Host:** GitHub Pages, via a custom worktree-push deploy (not `actions/deploy-pages`). Two separate workflows:

```
scrape.yml (cron, daily ~5am Pacific + manual dispatch)
  1. checkout repo, install Playwright chromium
  2. npm run scrape (all registered scrapers)
       → merge films across venues (dedup by title)
       → enrich via TMDB + OMDb API (cache + retry failures)
       → write public/data/showtimes.json
  3. commit showtimes.json → push to main
  4. push showtimes.json directly to the gh-pages branch's data/ dir
       (data-only deploy — never ships UI/code changes)

deploy.yml (manual "Run workflow" button, OR push to a release-* tag)
  1. npm run build → Next.js static export → /out/
  2. force-replace gh-pages branch contents with /out/
  3. on tag push: create a GitHub Release named "x.y.z-commithash"
```

**Failure handling:** If a scraper throws, the orchestrator's retry/timeout logic keeps last-known-good showtimes for that venue rather than wiping it (see `scrape.ts`). GitHub Pages continues serving the previous build regardless.

---

## Milestones

- [x] **M0 — Audit:** All target venues assessed. Rendering approach, ticketing platform, and scrape strategy documented per venue.
- [x] **M1 — First scraper:** Cinemagic scraper complete. Outputs normalized JSON with titles, showtimes, and ticket URLs.
- [x] **M2 — TMDB integration:** Enrichment working. Film records include poster, overview, canonical TMDB ID, director, genres. Enrichment cache, failure queue, and `--force` flag in place.
- [x] **M3 — All scrapers:** `public/data/showtimes.json` generated from all venues. As of 2026-07-22: 14 scrapers covering 16 venues (Cinemagic, Clinton Street, Laurelhurst, McMenamins/Baghdad, McMenamins/Kennedy School, Academy, Living Room, OMSI*, Cinema 21, Hollywood*, St. Johns, Moreland, Tomorrow, Mission, Avalon). *Hollywood and OMSI scrapers exist and work locally but are currently blocked from CI — see M7.
  - [x] Clinton Street Theater — The Events Calendar REST API (`/wp-json/tribe/events/v1/events`). Title normalization strips CST series labels ("Church of Film", "Cult Sensation:", Rocky Horror shadowcast suffixes). HTML entities decoded via cheerio.
  - [x] Laurelhurst Theater — `var gbl_movies` JSON blob embedded in homepage HTML. `dateTimeCMP` (YYYYMMDDHHMM 24h) parsed directly. "(open caption)" variants normalized and merged. Ticket URL constructed from `rtsSaleID_pk`.
  - [x] **McMenamins (Baghdad + Kennedy School)** — Scrapes `mcmenamins.com` venue pages (server-rendered HTML). Ticket URLs use Veezi ticketing (`ticketing.uswest.veezi.com`). One scraper covers both venues via `VENUES` array in `src/scrapers/mcmenamins.ts`. OCAP variants normalized and merged. Note: Veezi back-office REST API (`api.us.veezi.com`) requires a separate account token; the public `siteToken` in purchase URLs is for the consumer ticketing widget only and does not grant API access.
  - [x] **Mission Theater** — Same McMenamins events-page pattern, separate scraper (`src/scrapers/mission.ts`). Confirmed regular film screenings — no longer out of scope.
  - [x] **Academy Theater** — Webedia CMS REST API (`/api/gatsby-source-boxofficeapi/*`). No Playwright needed. Theater ID `X07OU`. Three endpoints: `scheduledMovies`, `schedule` (showtimes + ticket URLs per day), `movies` (details). Scraper at `src/scrapers/academy.ts`.
  - [x] **Living Room Theaters** — Playwright + GraphQL (`pdx.livingroomtheaters.com/graphql`). Portland site ID `317`, circuit ID `146`. Page load establishes session; custom headers (`site-id`, `circuit-id`, `client-type`) required for `showingsForDate` queries. Movies queried via intercepted response on page load; showings queried in parallel per date via `page.evaluate`. Ticket URLs constructed as `/purchase/{slug}?showingId={id}`. Scraper at `src/scrapers/living-room.ts`.
  - [x] **Cinema 21** — Server-rendered session API, works fine from CI. Scraper at `src/scrapers/cinema-21.ts`.
  - [x] **St. Johns Twin Cinema & Pub** — Cheerio on Veezi's public sessions widget (`ticketing.useast.veezi.com/sessions`). Scraper at `src/scrapers/st-johns.ts`.
  - [x] **Moreland Theater** — FMT (formovietickets.com) JSON schedule endpoint. Scraper at `src/scrapers/moreland.ts`.
  - [x] **Tomorrow Theater** — Custom WP REST API (`tomorrowtheater.org/wp-json/nj/v1`). Non-film live events filtered by title. Scraper at `src/scrapers/tomorrow.ts`.
  - [x] **Avalon Theatre** — Same Webedia boxofficeapi platform as Academy. Scraper at `src/scrapers/avalon.ts`.
  - [x] **OMSI Empirical Theatre** — Cheerio on omsi.edu to extract event UUIDs; Playwright-driven Eventbrite white-label REST API (`tickets.omsi.edu/cached_api`) for event details, calendar, and sessions (UTC). Non-film categories filtered via `category` field. `venue_id: omsi`. Works locally; **blocked from CI's datacenter IP** — see M7.
  - [x] **Hollywood Theatre** — WordPress REST API (`hollywoodtheatre.org/wp-json/wp/v2/event`) via `curl` with a browser User-Agent (Node's native `fetch` is blocked by Cloudflare's TLS fingerprinting). Scraper at `src/scrapers/hollywood.ts`. Works locally; **blocked from CI's datacenter IP** — see M7.
- [x] **M4 — Frontend v1:** What's on view with date picker, venue/genre filters, fuzzy search, compact/expanded modes, sort, Leaflet venue map, poster modal, IMDB links, ticket links. Deployed to GitHub Pages.
- [x] **M5 — Automated pipeline:** GitHub Actions cron running daily at 5am Pacific. Scrapers run in parallel. Scrape commits `upcoming.json` → triggers auto-deploy to GitHub Pages. Release tags (`release-X.Y.Z`) also trigger deploy.
- [ ] **M6 — Polish** (narrowed scope — calendar view and by-film/by-venue views dropped, already covered by existing filters):
  - [x] TMDB attribution (already in footer)
  - [x] Ratings — Rotten Tomatoes, IMDb, and Metacritic via OMDb API (keyed off the IMDb ID from TMDB enrichment). Badges per film, "Ratings unavailable" note when a matched film has none. Composite "Score" sort chip averages whichever ratings exist, normalizing IMDb to 0-100; unrated titles sort first rather than last.
  - [ ] Mobile layout polish — first pass done (responsive breakpoints for date cards, filter toggle row scroll-instead-of-wrap, showtime row stacking); another pass still planned
- [x] **M7 — Residential scrape fallback (live as of 2026-07-23):** OMSI scrapes from natty (a residential Pi/media server), pushed to GitHub, and picked up automatically by CI. Hollywood attempted the same way but still blocked (separate problem — see its venue-table note above). Lighter-weight than originally planned — see below for what actually shipped, and why it diverges from the original design.

---

## Residential Scrape Fallback (M7 — implemented)

### Problem

OMSI and Hollywood Theatre are blocked from GitHub Actions' datacenter IP. OMSI's CloudFront WAF rejects it by IP reputation; a residential IP clears it fine. (Hollywood turned out to be a different, harder problem — a Cloudflare JS challenge that appears to target Playwright's automation fingerprint rather than IP reputation, so it isn't solved by this fallback. See its venue-table note above.)

### What actually shipped (narrower than the original plan below)

The original design (further down this section, kept for history) called for splitting `scrape.ts` into a `scrape`/`build` pair joined by per-venue raw files for **every** venue. What we actually built is smaller: only the two CI-blocked venues need a Pi-sourced path, so rather than restructure the whole pipeline, `scrape.ts` gained a **per-scraper fallback**, and everything else is unchanged.

- **`src/pi-source.ts`** — `fetchPiRaw(venueId)` does a plain HTTPS GET of `https://raw.githubusercontent.com/mattlohkamp/small-screens-pdx/pi-data/data/raw/<venueId>.json` (no git clone, no auth — the file is public). Throws if the fetch fails or the data is older than 36 hours, so a dead Pi falls through to the orchestrator's existing last-known-good preservation instead of serving stale data forever.
- **`src/scrape.ts`** — `withPiFallback(venueId, scrapeFn)` wraps `omsi`'s and `hollywood`'s registry entries: try the real scraper first (still useful for local dev runs off a residential connection), and on failure fall back to `fetchPiRaw`. No CI-detection branching needed.
- **Code delivery to natty is `scp`, not `git pull`.** natty never clones this repo or runs `npm ci`/`npm install` on a schedule — code updates are copied over by hand, deliberately, so a compromised repo or dependency has no automated path to execute anything on the Pi. See `pi-scraper/` in this repo: a self-contained mirror (`package.json`, `run.ts`, and copies of `src/{types,fetch,browser,version,window}.ts` + `src/scrapers/{omsi,hollywood}.ts`) that gets `scp`'d to `~/small-screens-scraper` on natty whenever the scrapers change.
- **Data delivery is a dedicated push-only git branch (`pi-data`), not the main repo.** natty has a separate, minimal git checkout (`~/small-screens-data`) whose only remote branch is `pi-data`, authenticated via a repo-scoped GitHub deploy key (write access, this repo only — created specifically for this, not the user's personal key). natty only ever `git add`/`commit`/`push`es to it; it never fetches or pulls, so there's no path for anything committed elsewhere to reach natty automatically.
- **`~/small-screens-scraper/cron-scrape.sh`** — runs `run.ts` (writes `data/raw/{omsi,hollywood}.json` into the `small-screens-data` checkout, skipping a file entirely on scrape failure rather than overwriting it), then commits/pushes only if something changed. Cron: `15 4 * * *` (natty and Portland share a timezone), ahead of CI's `0 12 * * *` UTC (5am Pacific) run so fresh data is always waiting.

### What this gets, versus the original all-venues design

- Solves the actual problem (OMSI's data reaching the live site) with a much smaller change — no `build.ts` split, no event-driven build workflow, no raw file for the other 14 venues.
- Same safety property the original design wanted: a scraper failing writes nothing, so last-known-good is never overwritten — just achieved inside the existing orchestrator rather than via a file-presence convention.
- Costs: natty needs Playwright/Chromium (not just curl, since OMSI's own bypass needs a real browser context) — a bigger install than the original "curl only" Pi design assumed. Scraper code updates require a manual `scp`, not a `git pull` — a deliberate tradeoff for security (see above), but it does mean the Pi can silently run stale scraper code if an update is forgotten.

### Original design (superseded, kept for reference)

The original plan was a full `data/raw/<scraper>.json` per venue (all 16, not just the 2 blocked ones) with a dedicated `build.ts` merge/enrich step, triggered by an event-driven workflow on `data/raw/**` pushes. That's more infrastructure than the actual problem (2 blocked venues) needed, so it wasn't built. Worth revisiting only if more venues end up needing residential scraping, or if the fallback-per-scraper approach starts feeling cramped.

---

## Open Questions

1. ~~Any venues using Eventive or a shared ticketing platform?~~ Resolved: McMenamins Baghdad + Kennedy School use Veezi (has API). St. Johns also uses Veezi. Clinton Street uses Eventive for some events.
2. ~~Hollywood Theatre and Cinema 21 block automated requests — scraping approach TBD.~~ Partially resolved: Cinema 21 scrapes fine on CI. OMSI is confirmed working from natty (the residential Pi from M7) as of 2026-07-23. Hollywood is not — see the note above; it's a Cloudflare Turnstile challenge that appears to target Playwright's automation fingerprint specifically, not IP reputation, so the M7 "just run it from a residential IP" fix doesn't clear it on its own. Still open.
3. ~~Mission Theater — confirm no regular film screenings before dropping from scope.~~ Resolved: scraper built and confirmed working (`src/scrapers/mission.ts`); in scope.
