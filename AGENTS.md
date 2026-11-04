# Small Screens PDX: notes for coding agents

Read `README.md` for setup and `PLAN.md` for venue details, past decisions, and remaining work. This file is the detailed map plus the conventions that aren't obvious from the code.

## File map

```
src/
  scrape.ts          # Entry point: runs scrapers, merges, enriches, writes output, health, feeds
  merge.ts           # Cross-venue film merging (format suffixes, same-TMDB-id dupes)
  enrich.ts          # TMDB/OMDb enrichment, TMDB_ID_OVERRIDES, NON_FILM_TITLES
  cache.ts           # Local-only enrichment cache, 7-day TTL (CI never persists it)
  health.ts          # Per-venue health history, stale pi-scraper check, ntfy pushes
  feeds.ts           # iCal (all + per venue) and RSS of newly showing films
  pi-source.ts       # Reads pi-data raw files; expected pi-scraper code hash
  fetch.ts           # Shared fetch with timeouts and retries
  browser.ts         # Shared Playwright browser singleton
  window.ts          # WINDOW_DAYS (7)
  version.ts         # "x.y.z-commithash" version + scraper User-Agent
  types.ts           # Film / Showtime / Venue / Schedule
  scrapers/          # One per venue; mcmenamins.ts covers Bagdad + Kennedy School
pi-scraper/          # Self-contained package run on the residential host
  run.ts             # Scrapes Hollywood + OMSI, writes raw files for the pi-data branch
  src/code-hash.ts   # Code fingerprint stamped into raw files (shared with src/pi-source.ts)
  src/scrapers/hollywood.ts  # Hollywood's only scraper (headful patchright)
scripts/pi-sync.ts   # npm run pi:sync / pi:check
app/components/WhatsOn.tsx   # Nearly the whole UI
public/data/showtimes.json   # Generated, committed by CI
public/feeds/        # Generated feeds, gitignored; CI deploys them to gh-pages only
state/               # venue-health.json, feed-state.json; committed by CI
.github/workflows/   # scrape.yml (3x daily), deploy.yml (release tags), watchdog.yml (hourly)
```

## Conventions

- **Don't name the residential machine.** Docs and comments call it "the pi-scraper host".
- **Shared files in pi-scraper.** `pi-scraper/src/` holds copies of `types`, `fetch`, `browser`, `version`, `window` and `scrapers/omsi`. After editing any of these in `src/`, run `npm run pi:sync`. The pre-push hook runs `pi:check` and typecheck. Any change to `pi-scraper/` has to be copied to the host by hand, and CI alerts until it is.
- **Generated and state files.** Only CI writes `showtimes.json`, `state/*` and `public/feeds/` in a normal run. Locally, `--health` and `--feeds` opt in. Don't commit local scrape output.
- **CHANGELOG** lists user-facing changes only, under `[Unreleased]`.
- **Releasing:**
  1. Run `npm version x.y.z --no-git-tag-version`. Always bump: the version once sat at 0.1.0 for months because this step got skipped.
  2. Move the `[Unreleased]` changelog entries under `## [x.y.z] — YYYY-MM-DD`.
  3. Commit `chore: release x.y.z`, then `git tag release-x.y.z && git push origin main --tags`.
  4. The tag runs `deploy.yml`, which builds, publishes to gh-pages (leaving `feeds/` alone) and creates the GitHub Release. Scrapes deploy data only, never the UI.
- **Updating the pi-scraper host:** copy `pi-scraper/` over with a mirror that deletes extra files (e.g. `rsync --delete`), then run `npm ci` there. Until the host's `code_hash` matches the repo, each CI scrape sends a "pi-scraper host running old code" push.
- **Alerts:** tiers and thresholds are in `src/health.ts`, and PLAN.md has the full table. Alerts need the `NTFY_TOPIC` secret; `NTFY_SERVER` is an optional repo variable.
- **Commits.** Conventional Commits (`feat(scope):`, `fix(ci):`, `docs:`), straight to `main`.
- **Times.** Showtime datetimes are Portland wall time with no offset. Anchor "today" to `America/Los_Angeles`, never UTC.

## Gotchas on this machine (Windows, Git Bash)

- Git Bash rewrites leading-slash env values. Build with the base path like this: `MSYS_NO_PATHCONV=1 NEXT_PUBLIC_BASE_PATH=/small-screens-pdx npm run build`.
- Some files are CRLF (e.g. `CHANGELOG.md`), so string replacements that assume `\n` can miss. Use the Edit tool.
- `gh` isn't installed. The public GitHub API covers read-only checks of runs and jobs.
- `src/scrape.ts` starts a scrape when imported. Put testable helpers in their own module.
