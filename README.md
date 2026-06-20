# Small Screens PDX

A unified showtime aggregator for Portland's independent cinemas. Each theater publishes its own schedule on its own site — this pulls them all together into one searchable, filterable view.

**Live site:** https://mattlohkamp.github.io/small-screens-pdx/

## What it covers

8 venues currently scraped: Living Room Theaters, Laurelhurst Theater, Academy Theater, Clinton Street Theater, Cinemagic, OMSI Empirical Theatre, and the McMenamins theaters (Baghdad, Kennedy School). Cinema 21 and Hollywood Theatre block automated requests — approach TBD.

## How it works

A GitHub Actions cron job runs daily scrapers for each venue, enriches film data via the [TMDB API](https://www.themoviedb.org/), and produces a single `upcoming.json` covering a rolling two-week window. That JSON is the data layer for the React frontend, which handles all filtering and searching client-side. The built site is deployed to GitHub Pages.

## Tech stack

- **Scraping:** Node/TypeScript, Cheerio (static HTML), Playwright (JS-rendered pages)
- **Film metadata & posters:** TMDB API
- **Frontend:** Next.js (static export), React, Leaflet (venue map)
- **Data:** Static JSON, generated daily
- **CI/Deploy:** GitHub Actions → GitHub Pages

## Development

### Prerequisites

- Node.js 24+
- A free [TMDB API key](https://www.themoviedb.org/settings/api)

### Setup

```bash
npm install
cp .env.example .env
# add your TMDB_API_KEY to .env

# Prevent local scrape output from showing up as git changes
git update-index --skip-worktree public/data/upcoming.json
```

### Running the scraper

```bash
# Scrape all venues, enrich via TMDB, write public/data/upcoming.json
npm run scrape

# Scrape a single venue (partial update)
npm run scrape:academy
npm run scrape:living-room
# etc.

# Force re-enrich all films (bypasses cache)
npm run scrape:force
```

On subsequent runs, films already in the enrichment cache (`data/enrichment-cache.json`) are skipped — only new films and previous TMDB failures are re-queried. If any films couldn't be matched, a `public/data/failed-matches.json` is written with details; add the correct TMDB ID to `TMDB_ID_OVERRIDES` in [src/enrich.ts](src/enrich.ts) and re-run.

### Running the frontend

```bash
npm run dev
```

Uses whatever `public/data/upcoming.json` is on disk — either from a local scrape or pulled from the latest CI commit via `git pull`.

### Project structure

```
src/
  scrape.ts          # Entry point — orchestrates scraping, merging, enrichment
  enrich.ts          # TMDB enrichment, caching, failure tracking
  cache.ts           # Enrichment cache read/write
  browser.ts         # Shared Playwright browser singleton
  types.ts           # Shared TypeScript types
  scrapers/
    cinemagic.ts     # The Cinemagic Theater
    clinton-street.ts# Clinton Street Theater (Events Calendar REST API)
    laurelhurst.ts   # Laurelhurst Theater (embedded JSON blob)
    mcmenamins.ts    # Baghdad + Kennedy School (Veezi ticketing, server-rendered HTML)
    academy.ts       # Academy Theater (Webedia CMS REST API)
    living-room.ts   # Living Room Theaters (Playwright + GraphQL)
    omsi.ts          # OMSI Empirical Theatre (Cheerio + Eventbrite white-label API)
app/
  components/
    WhatsOn.tsx      # Main client component — filtering, search, film list
    VenueMap.tsx     # Leaflet map with venue pins
public/
  data/
    upcoming.json    # Generated output — tracked in git, committed by CI daily
data/
  enrichment-cache.json  # Persisted TMDB results (gitignored)
```

### Deployment

Push a `release-X.Y.Z` tag to trigger a build and deploy to GitHub Pages:

```bash
git tag release-1.0.0
git push origin release-1.0.0
```

The daily scrape cron also auto-deploys when it commits a changed `upcoming.json`.

---

*This product uses the TMDB API but is not endorsed or certified by TMDB.*
