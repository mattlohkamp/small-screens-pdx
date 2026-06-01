# Small Screens PDX

A unified showtime aggregator for Portland's independent cinemas. Each theater publishes its own schedule on its own site — this pulls them all together into one searchable, filterable view.

## What it covers

11 venues across Portland proper: Cinema 21, Hollywood Theatre, Living Room Theaters, Laurelhurst Theater, Academy Theater, Whitsell Auditorium (PAM CUT), Clinton Street Theater, Cinemagic, and the McMenamins theaters (Baghdad, Kennedy School).

## How it works

A GitHub Actions cron job runs daily scrapers for each venue, enriches film data via the [TMDB API](https://www.themoviedb.org/), and produces a single `upcoming.json` covering a rolling two-week window. That JSON is the data layer for the React frontend, which handles all filtering and searching client-side. The built site is deployed to NearlyFreeSpeech.net via rsync.

## Tech stack

- **Scraping:** Node/TypeScript, Cheerio (static HTML), Playwright (JS-rendered pages)
- **Film metadata & posters:** TMDB API
- **Frontend:** Next.js (static export), React
- **Data:** Static JSON, generated daily
- **CI/Deploy:** GitHub Actions → rsync → NearlyFreeSpeech.net

## Development

### Prerequisites

- Node.js 20+
- A free [TMDB API key](https://www.themoviedb.org/settings/api)

### Setup

```bash
npm install
cp .env.example .env
# add your TMDB_API_KEY to .env
```

### Running the scraper

```bash
# Scrape all venues, enrich via TMDB, write public/data/upcoming.json
npm run scrape

# Force re-enrich all films (bypasses cache)
npm run scrape:force
```

On subsequent runs, films already in the enrichment cache (`data/enrichment-cache.json`) are skipped — only new films and previous TMDB failures are re-queried. If any films couldn't be matched, a `public/data/failed-matches.json` is written with details; add the correct TMDB ID to `TMDB_ID_OVERRIDES` in [src/enrich.ts](src/enrich.ts) and re-run.

### Project structure

```
src/
  scrape.ts          # Entry point — orchestrates scraping, merging, enrichment
  enrich.ts          # TMDB enrichment, caching, failure tracking
  cache.ts           # Enrichment cache read/write
  types.ts           # Shared TypeScript types
  scrapers/
    cinemagic.ts     # The Cinemagic Theater scraper
public/
  data/
    upcoming.json    # Generated output (gitignored)
data/
  enrichment-cache.json  # Persisted TMDB results (gitignored)
```

---

*This product uses the TMDB API but is not endorsed or certified by TMDB.*
