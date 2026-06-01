# Small Screens PDX — Project Plan

## Overview

A website that aggregates showtimes from Portland's independent cinemas into a single, unified view. Each theater publishes its own schedule on its own site; this project scrapes them, enriches the data via TMDB, and presents it in one place — searchable, filterable, and browsable by film, venue, date, and format.

**Target audience:** Portlanders who care about independent cinema and want to know what's playing across all the small screens this week — without checking five different websites.

---

## Target Venues

Portland proper only — no Vancouver WA, Beaverton, or Clackamas.

| Venue | Neighborhood | Group | Screens | Website |
|---|---|---|---|---|
| Cinema 21 | NW / Alphabet District | — | 1 | cinema21.com |
| Hollywood Theatre | NE Portland | — | 1 | hollywoodtheatre.org |
| Living Room Theaters | Downtown | — | 6 | livingroomtheaters.com |
| Laurelhurst Theater | NE Portland | — | 4 | laurelhursttheater.com |
| Academy Theater | SE / Montavilla | — | 2 | academytheaterpdx.com |
| Whitsell Auditorium (PAM) | Downtown | — | 1 | portlandartmuseum.org |
| Clinton Street Theater | SE Portland | — | 1 | clintonstreettheater.com |
| Cinemagic | SE Portland | — | 1 | *(website to confirm during audit)* |
| Mission Theater | NW Portland | McMenamins | 1 | mcmenamins.com |
| Baghdad Theater | SE Portland | McMenamins | 1 | mcmenamins.com |
| Kennedy School Theater | NE Portland | McMenamins | 1 | mcmenamins.com |

**Estimated total: ~20 screens across 11 venues.**

> **Open question:** Some venues may use Eventive or another shared ticketing platform with an accessible API — worth checking during the site audit, as it could simplify those scrapers significantly.

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
    },
    {
      "id": "mission-theater",
      "name": "Mission Theater",
      "neighborhood": "NW Portland",
      "address": "1624 NW Glisan St, Portland OR",
      "lat": 45.5265,
      "lng": -122.6946,
      "website": "https://mcmenamins.com/mission-theater",
      "group": "mcmenamins"
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
- **Poster images:** Hotlinked from TMDB's CDN — `https://image.tmdb.org/t/p/w500/{poster_path}`. No local image storage needed.
- **Showtime format field:** Captures projection format where theaters provide it (35mm, 70mm, digital, DCP, etc.).
- **Deduplication:** If two venues are showing the same film, it appears once in `films[]` with multiple entries in its `showtimes[]` array.

### Client-side query patterns

Both primary query patterns are a single `.filter()` / `.flatMap()` on the loaded dataset:

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

1. **Audit each site** — determine if the schedule is server-rendered HTML, client-side JS, or an embedded widget (Eventive, Veezi, etc.). This determines the tool needed.
2. **Write a scraper per venue** — outputs raw showtime data normalized to our schema.
3. **TMDB enrichment step** — after scraping, look up each film by title + year against TMDB. Adds canonical ID, poster, overview, genres, runtime.
4. **Merge and write** — combine venue data and enriched film data into `upcoming.json`.
5. **Run on a schedule** — daily cron via GitHub Actions.

### Scraping tools

**Language: Node/TypeScript** throughout.

| Scenario | Tool |
|---|---|
| Server-rendered HTML | `cheerio` |
| JS-rendered pages | `playwright` |
| Shared ticketing platform | Hit the platform API directly if accessible |

### TMDB enrichment

```
scraper extracts: "The Substance" (2024), Cinema 21, 2026-06-01 19:30
  → search TMDB: GET /search/movie?query=The+Substance&year=2024
  → returns: tmdb_id, canonical title, poster_path, overview, runtime, genres
  → merge into film record
  → store tmdb_id as canonical film.id going forward
```

TMDB API is free. Requires a free account + API key. Rate limit: 40 req/sec — far more than we need. Attribution required: "This product uses the TMDB API but is not endorsed or certified by TMDB."

---

## Frontend

### Architecture

**React SPA** — a single `index.html` shell + JS bundle, served statically from NFSN. On load, fetches `upcoming.json` (~300KB estimated). All filtering, sorting, and searching happens client-side on the loaded dataset. No server required; no page-per-date generation.

**Why not pre-rendered static pages per date?** The primary use case is interactive — filter by venue, date, format, distance. The combination space can't be pre-built. And at ~700 showtimes / ~300KB, the full dataset loads and filters instantly client-side. Static pages would add complexity without benefit.

**Framework:** Next.js (static export) — React throughout, well-documented, `output: 'export'` produces flat files that deploy cleanly to NFSN via rsync. Familiar patterns for future React work.

### Views

**Primary (P0):**
- **What's on** — default view, showing today's showtimes across all venues. Filter by date (browse the 2-week window), venue, format, and group (e.g. "McMenamins only" or "exclude McMenamins").
- **By film** — all venues and showtimes for a selected film.
- **By venue** — full schedule for a selected venue.

**View modes (P0):**
- List/table view — sortable, scannable
- Calendar/grid view — days as columns, films as rows or blocks

**Later (P1+):**
- Distance filtering (browser geolocation + venue lat/lng, calculated client-side)
- Filter by format (35mm, 70mm, etc.)
- iCal / RSS feed
- Email/SMS alerts for specific films or directors
- Historical archive browsing (once data has accumulated)

---

## Hosting & Deployment

**Host:** NearlyFreeSpeech.net — pay-per-use, static file serving, SSH/rsync deployment. No server-side runtime.

**Pipeline:**

```
GitHub Actions cron (daily, ~5am Pacific)
  1. checkout repo
  2. npm run scrape
       → run each venue scraper
       → enrich films via TMDB API
       → write upcoming.json to /public/data/
  3. npm run build
       → Next.js static export reads from /public/data/
       → outputs flat HTML/CSS/JS to /out/
  4. rsync /out → NFSN via SSH
       → SSH key stored in GitHub Actions secrets
```

**Failure handling:** If any scraper throws, abort the run without overwriting `upcoming.json`. NFSN continues serving the previous day's build. GitHub Actions emails on failure.

---

## Milestones

- [ ] **M0 — Audit:** Visit all target venue sites. Document schedule page structure, determine scraper approach per venue, check for shared ticketing platforms.
- [ ] **M1 — First scraper:** Pick the simplest venue, scrape it end-to-end, output normalized JSON.
- [ ] **M2 — TMDB integration:** Enrichment step working. Film records include poster, overview, canonical ID.
- [ ] **M3 — All scrapers:** Full `upcoming.json` generated locally from all venues.
- [ ] **M4 — Frontend v1:** List view of today's showtimes. Filter by date and venue. Deployed to NFSN.
- [ ] **M5 — Automated pipeline:** GitHub Actions cron running, daily rebuild and deploy working end-to-end.
- [ ] **M6 — Polish:** Calendar view, by-film and by-venue views, mobile layout, TMDB attribution.

---

## Open Questions

1. Which venues are in scope for v1? (Suggest: start with 3–4 to prove the pipeline, then add the rest.)
2. Any venues using Eventive or a shared ticketing platform? (Audit will answer this.)
