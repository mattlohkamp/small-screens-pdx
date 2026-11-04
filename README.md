# Small Screens PDX

A unified showtime aggregator for Portland's independent cinemas. Each theater publishes its own schedule on its own site — this pulls them all together into one searchable, filterable view.

**Live site:** https://mattlohkamp.github.io/small-screens-pdx/

**Subscribe:** [calendar of every showtime](https://mattlohkamp.github.io/small-screens-pdx/feeds/all.ics), one calendar per venue (`feeds/<venue-id>.ics`, linked from the site footer), or [RSS of newly showing films](https://mattlohkamp.github.io/small-screens-pdx/feeds/new.xml).

## What it covers

15 venues with working scrapers:

- Academy Theater
- Avalon Theatre
- Bagdad Theater & Pub (McMenamins)
- The Cinemagic Theater
- Cinema 21
- Clinton Street Theater
- Hollywood Theatre*
- Kennedy School Theater (McMenamins)
- Laurelhurst Theater
- Living Room Theaters
- Mission Theater\*\*
- Moreland Theater
- OMSI Empirical Theatre*
- St. Johns Twin Cinema & Pub
- Tomorrow Theater

\* Hollywood and OMSI block GitHub Actions' datacenter IPs, so a residential
machine (running [`pi-scraper/`](pi-scraper/)) scrapes them and pushes
raw output to the `pi-data` branch; CI falls back to that when its own direct
scrape fails.

\*\* Mission Theater is mainly a live-show venue and screens films only a few
times a year, so it's usually empty here.

## How it works

A GitHub Actions cron job runs every venue's scraper three times a day, enriches film data via the [TMDB API](https://www.themoviedb.org/) and [OMDb](https://www.omdbapi.com/), and produces a single `showtimes.json` covering a rolling 7-day window. That JSON is the data layer for the React frontend, which handles all filtering and searching client-side. The built site is deployed to GitHub Pages.

## Tech stack

- **Scraping:** Node/TypeScript, Cheerio (static HTML), Playwright (JS-rendered pages)
- **Film metadata & posters:** TMDB API
- **Ratings (Rotten Tomatoes, IMDb, Metacritic):** OMDb API
- **Frontend:** Next.js (static export), React
- **Data:** Static JSON, regenerated three times a day
- **Alerts:** ntfy push notifications on scraper health
- **CI/Deploy:** GitHub Actions → GitHub Pages

## Development

### Prerequisites

- Node.js 24+
- A free [TMDB API key](https://www.themoviedb.org/settings/api)
- A free [OMDb API key](https://www.omdbapi.com/apikey.aspx) (for Rotten Tomatoes scores)

### Setup

```bash
npm install
cp .env.example .env
# add your TMDB_API_KEY and OMDB_API_KEY to .env

# Prevent local scrape output from showing up as git changes
git update-index --skip-worktree public/data/showtimes.json
```

### Running the scraper

```bash
# Scrape all venues, enrich via TMDB, write public/data/showtimes.json
npm run scrape

# Scrape a single venue (partial update)
npm run scrape:academy
npm run scrape:living-room
# etc.

# Force re-enrich all films (bypasses cache)
npm run scrape:force

# Also build the calendar/RSS feeds into public/feeds/ (CI always does)
npm run scrape -- --feeds
```

Hollywood always comes from the `pi-data` branch, and so does OMSI in CI. Locally, OMSI tries a direct scrape first.

### Updating pi-scraper

`pi-scraper/` keeps its own copies of a few `src/` files (`types`, `fetch`, `browser`, `version`, `window`, `scrapers/omsi`). After changing any of them, run `npm run pi:sync` and commit. The pre-push hook runs `npm run pi:check` and blocks the push if the copies have drifted.

Whenever `pi-scraper/` changes, copy it to the residential host and run `npm ci` there. Every file the host pushes is stamped with a hash of its code. If that doesn't match `pi-scraper/` in the repo, the next CI scrape sends a "pi-scraper host running old code" push. The push clears once the host catches up.

On subsequent runs, films already in the enrichment cache (`data/enrichment-cache.json`) are skipped — only new films and previous TMDB failures are re-queried. If any films couldn't be matched, a `public/data/failed-matches.json` is written with details; add the correct TMDB ID to `TMDB_ID_OVERRIDES` in [src/enrich.ts](src/enrich.ts) and re-run.

### Running the frontend

```bash
npm run dev
```

Uses whatever `public/data/showtimes.json` is on disk — either from a local scrape or pulled from the latest CI commit via `git pull`.

### Project structure

```
src/
  scrape.ts          # Entry point — orchestrates scraping, merging, enrichment
  enrich.ts          # TMDB/OMDb enrichment, caching, failure tracking
  cache.ts           # Enrichment cache read/write
  health.ts          # Per-venue health history + ntfy alerts
  merge.ts           # Cross-venue film merging (format suffixes, same-TMDB-id dupes)
  feeds.ts           # iCal calendars (all + per venue) and RSS of newly showing films
  pi-source.ts       # Fallback: read the pi-scraper host's latest raw output from pi-data
  fetch.ts           # Shared fetch with timeouts and retries
  window.ts          # Rolling showtime window length
  browser.ts         # Shared Playwright browser singleton
  version.ts         # x.y.z-commithash version string
  types.ts           # Shared TypeScript types
  scrapers/
    academy.ts       # Academy Theater (Webedia CMS REST API)
    avalon.ts        # Avalon Theatre (Webedia CMS REST API)
    cinema-21.ts     # Cinema 21 (site JSON API)
    cinemagic.ts     # The Cinemagic Theater (INDY GraphQL API)
    clinton-street.ts# Clinton Street Theater (Events Calendar REST API)
    laurelhurst.ts   # Laurelhurst Theater (embedded JSON blob)
    living-room.ts   # Living Room Theaters (Playwright + INDY GraphQL)
    mcmenamins.ts    # Bagdad + Kennedy School (server-rendered HTML)
    mission.ts       # Mission Theater (McMenamins events page)
    moreland.ts      # Moreland Theater (formovietickets JSON schedule)
    omsi.ts          # OMSI Empirical Theatre (local dev only; CI reads pi-data)
    st-johns.ts      # St. Johns Twin Cinema (Veezi sessions page)
    tomorrow.ts      # Tomorrow Theater (WordPress REST API)
pi-scraper/          # Separate package for the residential host: Hollywood + OMSI → pi-data branch
  src/scrapers/hollywood.ts  # Hollywood's only scraper (headful patchright)
  src/code-hash.ts   # Fingerprint stamped into pi-data, checked by CI
scripts/
  pi-sync.ts         # Keep pi-scraper's copies of shared src/ files in sync
app/
  components/
    WhatsOn.tsx      # Main client component — filtering, search, film list
public/
  data/
    showtimes.json    # Generated output — tracked in git, committed by each CI scrape
state/
  venue-health.json   # Rolling per-venue scrape history — committed by CI
  feed-state.json     # When each film first appeared (drives RSS) — committed by CI
data/
  enrichment-cache.json  # Local-only TMDB/OMDb cache, 7-day TTL (gitignored; CI never uses it)
```

### Scrape health alerts

Each CI scrape updates `state/venue-health.json`, a rolling 14-day per-venue
history, and pushes a phone notification via [ntfy](https://ntfy.sh) when:

- a venue's scraper **fails 2 runs in a row** (it already retries 3× per run),
- a venue that had showtimes on **≥10 of the last 14 days** comes back with an
  **empty week** — occasional-screening venues like Mission never trip this,
- the whole scrape job fails,
- the pi-scraper host is running an older copy of `pi-scraper/` than the repo,

and again when each problem clears. Severity maps to ntfy priority: whole run
failed = 5 (urgent), scraper failing = 4 (high), unexpectedly empty or stale
pi-scraper code = 3 (default), resolved = 2 (low). One push per alert type per
run with changes; silent otherwise. Thresholds and tiers live in `src/health.ts`.

A separate hourly workflow (`watchdog.yml`) covers runs GitHub delays or skips.
If the committed data is more than 12h old and no scrape is running, it starts
one and sends a priority 3 push.

Setup: install the ntfy app, subscribe to a hard-to-guess topic name, and add
it as the `NTFY_TOPIC` repo secret (Settings → Secrets and variables →
Actions). Optional `NTFY_SERVER` repo variable for a self-hosted server.
Local runs don't touch the health state unless you pass `--health`.

### Releasing

The version is a single scheme everywhere: **`x.y.z-commithash`**. The `x.y.z`
base lives in `package.json` (the source of truth); the `-commithash` suffix is
derived from the git SHA at build/scrape time, so it's always accurate. It shows
up in the `<meta name="build-version">` tag on the live site, the `generator`
field of `showtimes.json`, the scraper `User-Agent`, and the GitHub Release title.

To cut a release:

1. **Bump `package.json`** to the new `x.y.z` (e.g. `npm version 1.2.0 --no-git-tag-version`).
   Skipping this is how the version drifted to 0.1.0 before — don't.
2. **Update `CHANGELOG.md`** — move `[Unreleased]` entries under the new version.
   User-facing changes only (see the changelog's own convention).
3. **Commit**, then **tag and push**:
   ```bash
   git tag release-1.2.0
   git push origin main --tags
   ```

The tag push triggers the Deploy UI workflow: it builds, publishes to GitHub
Pages, and creates a GitHub Release titled `1.2.0-<commithash>` matching the
deployed build. The scheduled scrape also auto-deploys when it commits a
changed `showtimes.json` (data only, no UI/version change).

---

*This product uses the TMDB API but is not endorsed or certified by TMDB.*
