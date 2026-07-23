// Single source of truth for the scrape/display window: today plus the next
// 6 days (7 days total). Scrapers use it to bound what they fetch, scrape.ts
// uses it to trim before enrichment, and the UI exposes the same span.
export const WINDOW_DAYS = 7;
