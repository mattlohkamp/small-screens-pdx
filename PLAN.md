# Small Screens PDX — Project Plan

## Overview

A website that aggregates showtimes from Portland's independent cinemas into a single, unified view. Each theater publishes its own schedule on its own site; this project scrapes them, enriches the data via TMDB and OMDb, and presents it in one place — searchable, filterable, and browsable by film, venue, and date.

**Target audience:** Portlanders who care about independent cinema and want to know what's playing across all the small screens this week — without checking fifteen different websites.

**Status (2026-11-04):** Live at https://mattlohkamp.github.io/small-screens-pdx/, version 1.6.1. 15 venues scraped (Mission only occasionally has films); scrapes run 3x daily with per-venue health alerts. See [Remaining work](#remaining-work) for what's left.

---

## Target Venues

Portland proper only — no Vancouver WA, Beaverton, or Clackamas.

| Venue | Neighborhood | Group | Data source | Runs from | Status |
|---|---|---|---|---|---|
| Academy Theater | SE / Montavilla | — | Webedia CMS `boxofficeapi` (theater `X07OU`) | CI | ✓ |
| Avalon Theatre | SE / Belmont | Wunderland Games | Webedia CMS `boxofficeapi` (theater `X0430`), no ticket URLs | CI | ✓ |
| Bagdad Theater & Pub | SE Portland | McMenamins | mcmenamins.com server-rendered HTML; Veezi ticket links | CI | ✓ |
| The Cinemagic Theater | SE Portland | — | INDY GraphQL API (plain HTTP) | CI | ✓ |
| Cinema 21 | NW / Alphabet District | — | Site JSON API (`/api/movie/playing-now`) | CI | ✓ |
| Clinton Street Theater | SE Portland | — | The Events Calendar REST API | CI | ✓ |
| Hollywood Theatre | NE Portland | — | WP REST API behind a Cloudflare challenge; patchright, headful | pi-scraper host | ✓ |
| Kennedy School Theater | NE Portland | McMenamins | mcmenamins.com server-rendered HTML; Veezi ticket links | CI | ✓ |
| Laurelhurst Theater | NE Portland | — | `var gbl_movies` JSON blob in homepage HTML | CI | ✓ |
| Living Room Theaters | Downtown | — | INDY GraphQL via Playwright session | CI | ✓ |
| Mission Theater | NW Portland | McMenamins | McMenamins events page | CI | ✓ (rarely has films — see note) |
| Moreland Theater | SE / Sellwood | — | FMT (formovietickets.com) JSON schedule | CI | ✓ |
| OMSI Empirical Theatre | SE Portland | — | omsi.edu (Cheerio) + Eventbrite white-label API (Playwright) | pi-scraper host | ✓ |
| St. Johns Twin Cinema & Pub | N Portland / St. Johns | — | Veezi public sessions widget (Cheerio) | CI | ✓ |
| Tomorrow Theater | Downtown / Pearl | — | Custom WP REST API (`/wp-json/nj/v1`) | CI | ✓ |

**Total: 15 venues from 14 scrapers** (`mcmenamins.ts` covers Bagdad + Kennedy School). Registry lives in `src/scrape.ts`.

Venue notes worth keeping:

- **Cinemagic** moved its ticketing to the INDY platform around 2026-10-27; its film pages became a client-rendered SPA and the old JSON-LD scraper silently returned nothing for a week. The scraper now queries INDY's GraphQL API directly. Unlike Living Room (also INDY), Cinemagic's endpoint accepts plain HTTP as long as the site/circuit headers are present.
- **Hollywood** sits behind a Cloudflare JS challenge (Turnstile) that fingerprints automation, not IP. curl, Playwright `fetch()`, and Playwright navigation all failed, from both datacenter and residential IPs. Solved 2026-10-25 with `patchright` running **headful** (under `xvfb-run`): headless Chromium advertises `HeadlessChrome` in its UA and stays blocked even with patchright. It's an arms race; if Cloudflare closes this again, the standing call is to stop chasing this venue.
- **OMSI** is blocked from CI by CloudFront IP reputation; a residential IP clears it. Mixed programming — non-film categories (e.g. "Matches at the Museum") are filtered via the `category` field.
- **McMenamins**: the Veezi back-office API (`api.us.veezi.com`) needs an account token; the public `siteToken` in purchase URLs only works for the consumer widget. We scrape the server-rendered venue pages instead.
- **Mission Theater** is mainly a live-show venue and hosts film screenings only a few times a year, so an empty week is normal. Kept in scope so those rare screenings show up; the health check's empty-week alert never fires for it.
- **Cinema 21** scrapes fine from CI. Early drafts of this doc said it blocked scrapers; that was wrong.
- **Whitsell Auditorium (PAM CUT)** — dropped from scope, never scraped.

---

## Data Model

**Film is the primary entity.** Showtimes hang off films; venues are a lookup table.

### Runtime JSON structure

One file, `public/data/showtimes.json`, covers a rolling **7-day window** (today + 6 days, anchored to Portland time). Regenerated on each scrape run.

```json
{
  "generated_at": "2026-06-01T05:00:00Z",
  "generator": "1.6.1-abc1234",
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

There is no `release_date` field — TMDB's release date isn't captured yet. The "new releases" idea under [Remaining work](#remaining-work) would need it.

### Key design decisions

- **Film identity:** TMDB integer ID is the canonical key. `slug` (title + year) is the URL-friendly alias. Unmatched films keep `id: null` and still appear.
- **Match confidence:** `"verified"` for a direct TMDB match, `"fallback"` when the title only matched after stripping event flair ("… w/ Extra Footage", "… ON THE FOURTH OF JULY"). Fallback matches use conservative disambiguation and show a "Possible mismatch" badge.
- **Poster images:** Hotlinked from TMDB's CDN. No local image storage.
- **Deduplication:** Films are merged case-insensitively by title across scrapers before enrichment, so TMDB is called once per unique film per run.
- **Enrichment cache:** Successful lookups are cached in `data/enrichment-cache.json` (gitignored) and reused; only new films and previous failures hit the API.
- **Time zones:** Showtime datetimes are local Pacific with no offset. The scrape window and the site's "today" are both anchored to Portland time (an evening UTC rollover used to drop the current day — fixed in 1.4.2).

---

## Scraping Strategy

One scraper per venue (McMenamins excepted). Preference order for a data source: an API or JSON feed the site already uses → Cheerio on server-rendered HTML → Playwright on JS-rendered pages.

### Venue investigation workflow

1. **Human:** browse the site as a visitor and share the URLs that actually show the schedule.
2. **Claude:** inspect the data layer — JSON-LD, embedded JSON blobs, REST/GraphQL endpoints, ticketing-platform patterns, the page's own API calls.

### Pipeline (`npm run scrape`)

1. Run every registered scraper in parallel, each with a 90s timeout and orchestrator-level retries.
2. A scraper that still fails keeps its venue's last-known-good showtimes instead of wiping them.
3. Merge films across venues, enrich via TMDB (+ OMDb ratings), write `showtimes.json` and `failed-matches.json`.
4. Update `state/venue-health.json` and send ntfy alerts on changes (CI runs, or locally with `--health`).

`npm run scrape <id…>` does a partial run that patches only those venues.

### TMDB / OMDb enrichment

```
scraper extracts: "The Substance" (2024), Cinema 21, 2026-06-01 19:30
  → search TMDB (verbatim title; on miss, retry with event flair stripped)
  → disambiguate: unique result, unique year, or exact title + release date
  → fetch details + credits + external IDs (IMDb)
  → OMDb by IMDb ID → RT, IMDb, Metacritic scores (best-effort each)
  → merge into film record, cache result
```

Unmatched films are written to `public/data/failed-matches.json`; manual fixes go into `TMDB_ID_OVERRIDES` in `src/enrich.ts`. Unverified and mismatch badges on the site link to a pre-filled GitHub issue for reporting.

### Residential scraping (pi-scraper)

OMSI and Hollywood can't be scraped from GitHub Actions. A separate machine on a residential connection runs `pi-scraper/` and pushes raw output to the `pi-data` branch; CI reads it as a fallback.

- **`src/pi-source.ts`** — `fetchPiRaw(venueId)` does a plain HTTPS GET of `data/raw/<venueId>.json` from the `pi-data` branch on raw.githubusercontent.com (no clone, no auth). Throws if the file is missing or older than 36 hours, so a dead host falls through to last-known-good instead of serving stale data forever.
- **`withPiFallback()`** in `src/scrape.ts` wraps the `omsi` and `hollywood` entries: try the direct scraper first (works for local dev on a residential connection), fall back to `fetchPiRaw` on failure.
- **Code delivery is `scp`, not `git pull`.** The host never clones this repo or installs dependencies on a schedule, so a compromised repo or dependency has no automated path to run anything there. `pi-scraper/` is a self-contained mirror (own `package.json` + lockfile, `run.ts`, copies of the shared `src/` modules and the two scrapers) that's copied over by hand when the scrapers change.
- **Data delivery is push-only.** The host has a minimal checkout whose only remote branch is `pi-data`, authenticated with a repo-scoped deploy key. It only ever commits and pushes; it never fetches.
- **Schedule:** host cron `15 4,12,18 * * *` Pacific, ahead of each CI run in both PST and PDT. Order only affects freshness.
- `pi-scraper/` is excluded from the root TypeScript program; CI's `npm ci` doesn't install its dependencies (`patchright`), and including it broke the UI build from 2026-10-25 to 1.6.1.

---

## Frontend

**Next.js static export** (`output: 'export'`), deployed to GitHub Pages. On load it fetches `showtimes.json`; all filtering, sorting, and searching is client-side.

A single `WhatsOn` view (`app/components/WhatsOn.tsx`) covers the product:

- 7 tear-off-calendar date cards; "no more showtimes today" state with a jump to tomorrow
- Venue and genre filters (opt-in chips, "Not McMenamins" preset), fuzzy search (Fuse.js), and Matinee / < 2h / Hide past / Hide unverified toggles with live counts
- Sort by A–Z, Showtime, Runtime, or composite ratings Score
- RT / IMDb / Metacritic badges, posters, overview, IMDb links, ticket links, format and event-note annotations
- "Browse by movie" picker: every film this week, opening a single-film view grouped by theater, then day
- Mobile: pull-down options drawer, compact cards, slide-over film detail view

Separate by-film / by-venue / calendar views were planned originally and dropped — the filter set covers them. The Leaflet venue map shipped in M4 and was removed in 1.4.0 (it wasn't earning its space).

---

## Hosting & Deployment

**Host:** GitHub Pages, via a worktree push to the `gh-pages` branch (not `actions/deploy-pages`). Both workflows share a `gh-pages` concurrency group so they never push at once.

```
scrape.yml  (cron "37 2,12,20 * * *" UTC + manual dispatch)
            = ~6:37pm / 4:37am / 12:37pm PST (an hour later in PDT)
  1. checkout, npm ci, Playwright Chromium (cached); runner pinned to ubuntu-24.04
  2. npm run scrape  → scrape, merge, enrich, write showtimes.json, update health + ntfy
  3. commit showtimes.json + state/venue-health.json → push to main
  4. copy showtimes.json into gh-pages data/ (data-only deploy — never ships UI)
  5. on any failure: urgent ntfy push with a link to the run

deploy.yml  (push of a release-* tag, or manual dispatch)
  1. npm run build → static export → force-replace gh-pages contents
  2. on tag push: GitHub Release titled "x.y.z-commithash"
```

The cron runs off the top of the hour on purpose: GitHub's scheduler is most congested at :00, and the old `0 12` run routinely started 3–6 hours late. Scheduled runs can still be delayed or skipped entirely (both 2026-11-04 morning runs never started); health alerting doesn't catch that yet.

The runner is pinned to `ubuntu-24.04` because `ubuntu-latest` moved to 26.04 in October 2026 and Playwright had no browser builds for it.

### Scrape health alerts

`src/health.ts` keeps a rolling 14-day per-venue history in `state/venue-health.json` (committed by CI) and pushes to an ntfy topic (`NTFY_TOPIC` secret) when a problem starts and when it clears:

| Event | ntfy priority |
|---|---|
| Whole scrape job failed (sent from `scrape.yml`) | 5 urgent |
| A venue's scraper failed 2 runs in a row (each run already retries) | 4 high |
| A venue with showtimes on ≥10 of the last 14 days returns an empty week | 3 default |
| A problem resolved | 2 low |

One push per tier per run, silent otherwise. Each push body starts with the exact Pacific time, because the ntfy app only shows relative times. Occasional-screening venues (e.g. Mission) never trip the empty-week alert.

---

## Milestones

- [x] **M0 — Audit:** all target venues assessed for rendering, ticketing platform, and scrape strategy.
- [x] **M1 — First scraper:** Cinemagic.
- [x] **M2 — TMDB integration:** enrichment, cache, failure queue, overrides, `--force`.
- [x] **M3 — All scrapers:** 14 scrapers / 15 venues. Hollywood and OMSI completed via M7.
- [x] **M4 — Frontend v1:** What's On view, filters, search, sort, posters, ticket links. Deployed.
- [x] **M5 — Automated pipeline:** scheduled scrape → commit → data-only deploy; release tags deploy the UI. Daily at first; 3x daily since 2026-11-03.
- [ ] **M6 — Polish** (narrowed scope):
  - [x] TMDB / OMDb attribution
  - [x] Ratings — RT, IMDb, Metacritic via OMDb; composite Score sort
  - [x] Mobile rework — options drawer, compact cards, slide-over detail (1.3.0, 1.5.0)
  - [x] Browse-by-movie picker (1.6.0)
  - [ ] Another mobile layout pass
- [x] **M7 — Residential scrape fallback:** OMSI live in production 2026-07-23; Hollywood live 2026-10-25 via patchright.
- [x] **M8 — Scrape health monitoring:** per-venue history, tiered ntfy alerts, whole-run failure alert (1.6.1, 2026-11-03).

---

## Decisions and changes of course

| Date | Decision | Why |
|---|---|---|
| 2026-06 | Static JSON + client-side filtering, no backend | One file per run is small; GitHub Pages is free and needs no upkeep. |
| 2026-06 | Dropped separate by-film / by-venue / calendar views | The filter set covers them in one view. |
| 2026-06-29 | Split data deploys (every scrape) from UI deploys (release tags only) | A scheduled scrape should never ship unreviewed UI changes. |
| 2026-07-06 | Removed the venue map (1.4.0) | Not earning its space. |
| 2026-07-22 | M7 shipped as a per-scraper fallback instead of the planned all-venues raw-file pipeline | Only 2 venues are blocked; a `build.ts` split and event-driven workflow was more infrastructure than the problem needed. Revisit only if more venues need residential scraping. |
| 2026-07-22 | Code reaches the residential host by hand (`scp`), data leaves by push-only branch | No automated path from the repo or npm onto a home machine. Cost: the host can silently run stale scraper code. |
| 2026-10-25 | Hollywood via headful patchright; stop chasing it if this breaks | Cloudflare fingerprints automation, not IP; this is an arms race. |
| 2026-11-03 | Cinemagic via INDY GraphQL | Site became a client-rendered SPA. |
| 2026-11-03 | Scrape 3x daily at :37 | Fresher listings; avoid GitHub's :00 congestion. |
| 2026-11-03 | Per-venue health + ntfy, tiered by priority | Cinemagic was silently empty for a week before anyone noticed. |
| 2026-11-04 | Keep the residential host anonymous in the repo | It's a personal machine; docs say "pi-scraper host". |

---

## Remaining work

**Reliability**
- [ ] **Detect skipped scheduled runs.** Health alerts only fire from runs that start. If GitHub skips the cron (as on 2026-11-04), nothing alerts. Options: alert when `generated_at` gets too old (e.g. from the pi-scraper host or an external check), or a lightweight watchdog workflow.
- [ ] **Stop wasting CI time on Hollywood's direct scrape.** `src/scrapers/hollywood.ts` is the stock-Playwright version, which can't pass Cloudflare anywhere; CI retries it before falling back. Either go straight to `fetchPiRaw` in CI, or retire the CI copy.
- [ ] **pi-scraper drift.** Its copies of the shared modules and scrapers are synced to `src/` by hand, then to the host by hand. Some check (a diff script, or a version stamp in the raw output) would catch a stale host.
- [ ] Watch the `ubuntu-24.04` pin; move back to `ubuntu-latest` once Playwright supports 26.04.

**Product (P1+)**
- [ ] Another mobile layout pass (M6).
- [ ] Filter by format (35mm, 70mm, …) — data is captured, no filter yet.
- [ ] Filter by new releases / first run — needs `release_date` from TMDB.
- [ ] Distance filtering (geolocation + venue lat/lng).
- [ ] Enrichment cache invalidation via TMDB's `/movie/changes`.
- [ ] iCal / RSS feed.
- [ ] Alerts for specific films or directors.
- [ ] Historical archive browsing.
