export interface Venue {
  id: string;
  name: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  website: string;
  group: string | null;
}

export interface Showtime {
  venue_id: string;
  datetime: string; // ISO 8601 local datetime, e.g. "2026-06-01T19:30:00"
  format: string | null;
  ticket_url: string | null;
  // Extra text stripped from the venue's raw title while matching to TMDB, e.g.
  // "w/ Extra Footage" — describes what's different about this specific showing.
  event_note?: string | null;
}

export interface Film {
  id: number | null; // TMDB ID once enriched, null before
  slug: string;
  title: string;
  year: number | null;
  director: string | null;
  runtime_minutes: number | null;
  overview: string | null;
  poster_path: string | null;
  genres: string[];
  imdb_id?: string | null;
  showtimes: Showtime[];
  // "verified": matched on the venue's title as given. "fallback": matched after
  // stripping event flair from the title (see enrich.ts) — worth a light "possible
  // mismatch" flag since the match wasn't as direct. Absent for unmatched films.
  match_confidence?: "verified" | "fallback";
}

export interface Schedule {
  generated_at: string;
  window: { start: string; end: string };
  venues: Venue[];
  films: Film[];
}
