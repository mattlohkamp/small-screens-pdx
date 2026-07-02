# Changelog

## [Unreleased]

### Added
- Date picker replaced with 7 calendar-day cards spanning the full width, styled like tear-off calendar pages (month strip, large day-of-month, weekday); day numbers shown as ordinals ("1st", "22nd")
- "No more showtimes today" empty state with a "View tomorrow" link when the day isn't empty, just past — distinct from a genuinely showtime-free day
- "Hide McMenamins" and "Hide unverified" filter toggles; all toggle buttons now show a live count (e.g. "Matinee (5)", "Hide unverified (2)")
- Results heading ("Showtimes July 2nd, 2026 (61 shown, 15 filtered out)") between the filters panel and the sort row
- Venue map moved out of the header into a collapsed-by-default "See venues on map (N)" section with a folded-map SVG icon
- TMDB matching now falls back to stripping event flair from venue titles ("BACKROOMS: Everything Must Go Ed. w/ Extra Footage", "UNCLE SAM (1996) ON THE FOURTH OF JULY") when the verbatim title doesn't match, using conservative disambiguation (unique result, unique year, or exact-title-with-release-date) to avoid false matches
- `Film.match_confidence` ("verified" | "fallback") and `Showtime.event_note` — surfaced in the UI as an amber "Possible mismatch" badge and inline showtime annotation, respectively
- "Unverified" and "Possible mismatch" badges are now links that open a pre-filled GitHub issue for reporting a bad match
- `Film.imdb_id` fetched from TMDB — film titles link directly to the matched IMDB page instead of an IMDB search query
- Per-run scrape logs appended to `public/data/scrape.log` (gitignored, local-only) for debugging scraper failures

### Fixed
- McMenamins venue set was missing Mission Theater (only had Baghdad + Kennedy School), undercounting the "Not McMenamins" filter
- Hollywood Theatre scraper was surfacing non-screening WordPress posts (classes, talks, podcast-style series) as if they were showtimes — added title-based exclusions ("The World is Wrong About…" prefix, "Jim Jarmusch's America") after confirming via Hollywood's own show data that these aren't ticketed screenings
- "Devo 250: The Beginning Was The End" at Hollywood now correctly resolves to the real 1976 Devo film via a curated TMDB override

---

## [1.0.0] — 2026-06-19

### Added
- GitHub Actions deploy workflow — push a `release-1.x.x` tag to build and rsync to NearlyFreeSpeech.net
- Filter UX: opt-in model (empty = All; first click narrows to one venue/genre; additional clicks expand selection); "Not McMenamins" preset shortcut
- "Hide past showtimes" toggle (on by default)
- Compact/Expanded view toggle moved inline with sort controls
- Show/Hide filters panel (search, venue, genre) — hidden by default, slides open; auto-reveals when a filter is applied from the film list
- Venue names and genre tags in film rows clickable as filter shortcuts, with tooltips
- Ticket icon link (🎟↗) next to each venue's showtimes → venue's own film page
- Poster click → full-size modal; film title click → IMDB search in new tab
- Runtime displayed as human-readable text (e.g. "50 minutes", "1 hour", "2 hrs 15 mins")
- Date labels show full date context ("Today (Thu, Jun 19)", "Tomorrow (Fri, Jun 20)")
- Clear (✕) button inline after active filter summary

### Fixed
- "Today" and the explicit date entry now always match — UTC date bug (using `toISOString()` after 5pm Pacific returned the next day's date; fixed using local `getFullYear/getMonth/getDate`)
- Custom date picker chevron spacing (replaced browser-native arrow with `appearance: none` + CSS `::after` overlay)
- Collapsible caret moved to left of label as bullet prefix

---

## [0.4.0] — 2026-06-19

### Added
- Next.js frontend (`app/`) with `output: 'export'` static build — fetches `upcoming.json` client-side
- **What's on view** — default landing page showing showtimes for a selected date across all venues
- Date picker dropdown (2-week window), defaults to today
- Expanded layout — film poster, title, year, director, runtime, genres, showtimes grouped by venue
- Compact layout — dense single-line format, no poster; toggle persisted to `localStorage`
- Fuzzy search via Fuse.js across title (weight 4), genre (2), venue name (1.5), director (1) with match character highlighting in results
- Genre filter (multi-select chips, collapsible), venue filter (collapsible), both default to collapsed with active-selection summary shown in header
- Matinee toggle (before 5pm) and < 2h runtime toggle, inline next to date picker
- Sort by showtime, A–Z, or runtime; RT Score placeholder (greyed out, planned)
- Genre and venue chips disabled with tooltip when no showtimes available on selected date
- TMDB poster images hotlinked from `image.tmdb.org/t/p/w154`
- TMDB attribution in footer

---

## [0.3.0] — 2026-06-19

### Added
- Clinton Street Theater scraper (`src/scrapers/clinton-street.ts`) — The Events Calendar REST API (`/wp-json/tribe/events/v1/events`); strips series labels ("Church of Film:", "Cult Sensation:", Rocky Horror shadowcast suffixes); decodes HTML entities via cheerio
- Laurelhurst Theater scraper (`src/scrapers/laurelhurst.ts`) — parses `var gbl_movies` JSON blob embedded in homepage HTML; `dateTimeCMP` field (YYYYMMDDHHMM) parsed directly; open caption variants normalized and merged
- McMenamins scraper (`src/scrapers/mcmenamins.ts`) — covers Baghdad Theater and Kennedy School Theater via server-rendered HTML; one scraper, two venues via `VENUES` array; OCAP variants normalized
- Academy Theater scraper (`src/scrapers/academy.ts`) — Webedia CMS REST API (`/api/gatsby-source-boxofficeapi/*`); no Playwright needed; theater ID `X07OU`
- Living Room Theaters scraper (`src/scrapers/living-room.ts`) — Playwright + GraphQL (`pdx.livingroomtheaters.com/graphql`); Portland site ID `317`; custom headers established via page load; showings queried in parallel per date via `page.evaluate`
- OMSI Empirical Theatre scraper (`src/scrapers/omsi.ts`) — Cheerio on `omsi.edu` to extract event UUIDs; Eventbrite white-label REST API (`tickets.omsi.edu/cached_api`) for event details, available dates, and UTC session times; no Playwright needed; non-film categories filtered via `category` field
- Partial scrape support — `npm run scrape [venue-id...]` runs only the specified scrapers and patches the existing `upcoming.json` (strips old showtimes for those venues, merges fresh data, re-enriches new titles); full per-venue npm scripts added
- `SCRAPERS` registry in `src/scrape.ts` mapping scraper IDs to functions and covered venue IDs

### Fixed
- `mergeFilms()` now deduplicates case-insensitively (`"STOP! THAT! TRAIN!"` + `"Stop! That! Train!"` → one record)

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
