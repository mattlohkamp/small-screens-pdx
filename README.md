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

\* Hollywood and OMSI block GitHub Actions' datacenter IPs, so a machine on a
residential connection scrapes them with [`pi-scraper/`](pi-scraper/) and
publishes the results to the `pi-data` branch, where CI picks them up.

\*\* Mission Theater is mainly a live-show venue and screens films only a few
times a year, so it's usually empty here.

## How it works

A GitHub Actions cron job runs every venue's scraper three times a day, enriches film data via the [TMDB API](https://www.themoviedb.org/) and [OMDb](https://www.omdbapi.com/), and produces a single `showtimes.json` covering a rolling 7-day window. That JSON is the data layer for the React frontend, which handles all filtering and searching client-side. The built site is deployed to GitHub Pages.

## Tech stack

- **Scraping:** Node/TypeScript, Cheerio (static HTML), Playwright (JS-rendered pages)
- **Film metadata & posters:** [TMDB API](https://www.themoviedb.org/)
- **Ratings ([Rotten Tomatoes](https://www.rottentomatoes.com/), [IMDb](https://www.imdb.com/), [Metacritic](https://www.metacritic.com/)):** [OMDb API](https://www.omdbapi.com/)
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

# Keep local scrape output out of git status
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

(Hollywood always comes from the `pi-data` branch, and so does OMSI in CI. Locally, OMSI tries a direct scrape first.)

Local runs cache TMDB/OMDb lookups in `data/enrichment-cache.json` for 7 days. Films that can't be matched are listed in `public/data/failed-matches.json`; the fix is an entry in `TMDB_ID_OVERRIDES` in [src/enrich.ts](src/enrich.ts).

### Running the frontend

```bash
npm run dev
```

Uses whatever `public/data/showtimes.json` is on disk — either from a local scrape or pulled from the latest CI commit via `git pull`.

### Project layout

- **`src/`**: the scraper pipeline (Node/TypeScript). `scrape.ts` is the entry point, with one scraper per venue in `src/scrapers/`.
- **`pi-scraper/`**: a small separate package that scrapes the two venues GitHub blocks (Hollywood, OMSI) from a residential machine.
- **`app/`**: the Next.js frontend, mostly a single component (`app/components/WhatsOn.tsx`).
- **`public/data/showtimes.json`**: the generated data the site reads, committed by CI.
- **`state/`**: history CI keeps between runs (health alerts, RSS first-seen dates).
- **`.github/workflows/`**: the scheduled scrape, the UI deploy, and an hourly watchdog.

### Monitoring

Each CI scrape records per-venue results in `state/venue-health.json` and sends [ntfy](https://ntfy.sh) push notifications when a scraper keeps failing, a usually busy venue comes back empty, or a whole run fails. An hourly watchdog workflow starts a scrape if GitHub skips a scheduled one. Details are in [PLAN.md](PLAN.md). To get alerts on a fork, set an `NTFY_TOPIC` repository secret.

### Versioning

The version is semver plus a commit hash: `x.y.z-commithash`. The semver lives in
`package.json`; the hash is the git SHA at build/scrape time. It appears in the
site's `build-version` meta tag, `showtimes.json`, the scraper User-Agent, and
GitHub Release titles. Pushing a `release-x.y.z` tag builds and deploys the site
and creates the matching GitHub Release. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

---

*This product uses the TMDB API but is not endorsed or certified by TMDB.*
