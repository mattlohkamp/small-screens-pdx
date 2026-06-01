# Small Screens PDX

A unified showtime aggregator for Portland's independent cinemas. Each theater publishes its own schedule on its own site — this pulls them all together into one searchable, filterable view.

## What it covers

11 venues across Portland proper: Cinema 21, Hollywood Theatre, Living Room Theaters, Laurelhurst Theater, Academy Theater, Whitsell Auditorium (PAM), Clinton Street Theater, Cinemagic, and the three McMenamins theaters (Mission, Baghdad, Kennedy School).

## How it works

A GitHub Actions cron job runs daily scrapers for each venue, enriches film data via the [TMDB API](https://www.themoviedb.org/), and produces a single `upcoming.json` covering a rolling two-week window. That JSON is the data layer for the React frontend, which handles all filtering and searching client-side. The built site is deployed to NearlyFreeSpeech.net via rsync.

## Tech stack

- **Scraping:** Node/TypeScript, Cheerio (static HTML), Playwright (JS-rendered pages)
- **Film metadata & posters:** TMDB API
- **Frontend:** Next.js (static export), React
- **Data:** Static JSON, generated daily
- **CI/Deploy:** GitHub Actions → rsync → NearlyFreeSpeech.net

## Development

> Setup instructions coming once the project scaffold is in place.

---

*This product uses the TMDB API but is not endorsed or certified by TMDB.*
