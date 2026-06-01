# Changelog

## [Unreleased]

Next: frontend scaffolding (Next.js static export, load `upcoming.json`, render showtime list).

---

## [0.2.0] — 2026-05-31

### Added
- TMDB enrichment (`src/enrich.ts`) — film records now include canonical TMDB ID, poster path, director, genres, corrected runtime, and overview
- Enrichment cache (`data/enrichment-cache.json`) — successful TMDB lookups persisted across runs; only new films and previous failures hit the API
- Failed-match queue — unmatched films written to `public/data/failed-matches.json` with a console warning listing what needs manual attention
- `TMDB_ID_OVERRIDES` map in `src/enrich.ts` for venue title typos and obscure films that don't match via search (first entry: "964 Pinnochio" → TMDB 50162)
- `--force` flag (`npm run scrape:force`) to bypass cache and re-enrich all films
- Cross-scraper film deduplication in `src/scrape.ts` — films shared across venues are merged before enrichment, so TMDB is called once per unique title per run
- `src/cache.ts` — cache read/write utilities
- `src/scrape.ts` — main pipeline entry point wiring scraping, merging, enrichment, and output together
- `.env.example` for TMDB API key setup

---

## [0.1.0] — 2026-05-31

### Added
- Project scaffold: `package.json`, `tsconfig.json`, `.gitignore`
- `src/types.ts` — core data model (`Film`, `Showtime`, `Venue`, `Schedule`)
- Cinemagic scraper (`src/scrapers/cinemagic.ts`) — fetches `tickets.thecinemagictheater.com/now-showing/`, follows each film page, extracts title, runtime, overview, genres, and all upcoming showtimes via JSON-LD + cheerio
- `npm run scrape:cinemagic` for standalone scraper testing
- Venue site audit covering all 11 target venues — rendering approach, ticketing platform, and scrape difficulty documented in PLAN.md
