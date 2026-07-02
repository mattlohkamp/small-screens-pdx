"use client";

import { useEffect, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import Fuse, { type FuseResult, type FuseResultMatch } from "fuse.js";
import styles from "./WhatsOn.module.css";

const VenueMap = dynamic(() => import("./VenueMap"), { ssr: false });

type MatchIndices = ReadonlyArray<[number, number]>;

interface FilmMatches {
  title: MatchIndices;
  director: MatchIndices;
  genres: Map<string, MatchIndices>;
}

function highlightText(text: string, indices: MatchIndices): React.ReactNode {
  if (!indices.length) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of indices) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={start} className={styles.highlight}>{text.slice(start, end + 1)}</mark>);
    cursor = end + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function buildMatchMap(results: FuseResult<{ film: { slug: string } }>[]): Map<string, FuseResultMatch[]> {
  const map = new Map<string, FuseResultMatch[]>();
  for (const r of results) {
    map.set(r.item.film.slug, (r.matches ?? []) as FuseResultMatch[]);
  }
  return map;
}

interface Venue {
  id: string;
  name: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  website: string;
  group: string | null;
}

interface Showtime {
  venue_id: string;
  datetime: string;
  format: string | null;
  ticket_url: string | null;
  event_note?: string | null;
}

interface Film {
  id: number | null;
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
  match_confidence?: "verified" | "fallback";
}

interface Schedule {
  generated_at: string;
  window: { start: string; end: string };
  venues: Venue[];
  films: Film[];
}

function buildFilmPageUrl(venueId: string, film: Film, venue: Venue): string {
  const titleSlug = film.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  switch (venueId) {
    case "living-room":
      return `https://pdx.livingroomtheaters.com/movie/${titleSlug}`;
    default:
      return venue.website;
  }
}

// Link directly to the matched title's IMDB page when we have it; only fall
// back to an IMDB search for films that TMDB didn't resolve (id === null).
function imdbUrl(film: Film): string {
  if (film.imdb_id) return `https://www.imdb.com/title/${film.imdb_id}/`;
  return `https://www.imdb.com/find?q=${encodeURIComponent(`${film.title} ${film.year ?? ""}`)}&s=tt&ttype=ft`;
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  if (m === 0) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return `${h} ${h === 1 ? "hr" : "hrs"} ${m} ${m === 1 ? "min" : "mins"}`;
}

function formatTime(datetime: string): string {
  const [, time] = datetime.split("T");
  const [h, m] = time.split(":");
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 || 12;
  return `${h12}:${m}${ampm}`;
}

function formatDateLabel(dateStr: string, today: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const short = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (dateStr === today) return `Today (${short})`;
  const tomorrow = new Date(today + "T12:00:00");
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  if (dateStr === tomorrowStr) return `Tomorrow (${short})`;
  return short;
}

function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return `${n}st`;
  if (n % 10 === 2 && n % 100 !== 12) return `${n}nd`;
  if (n % 10 === 3 && n % 100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function formatFullDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const month = d.toLocaleDateString("en-US", { month: "long" });
  const year = d.getFullYear();
  return `${month} ${ordinal(d.getDate())}, ${year}`;
}

function formatDayCardLabel(dateStr: string): { weekday: string; month: string; day: string } {
  const d = new Date(dateStr + "T12:00:00");
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const month = d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  const day = ordinal(d.getDate());
  return { weekday, month, day };
}

function buildDateWindow(start: string, end: string): string[] {
  const dates: string[] = [];
  const d = new Date(start + "T12:00:00");
  const endDate = new Date(end + "T12:00:00");
  while (d <= endDate) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

type ViewMode = "expanded" | "compact";
type SortBy = "time" | "title" | "runtime";

const MATINEE_CUTOFF = "17:00"; // before 5pm
const MCMENAMINS_IDS = new Set(["baghdad", "kennedy-school", "mission"]);

export default function WhatsOn() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posterModal, setPosterModal] = useState<{ src: string; title: string } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedVenues, setSelectedVenues] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("expanded");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("time");
  const [genreFilter, setGenreFilter] = useState<Set<string>>(new Set());
  const [matineeOnly, setMatineeOnly] = useState(false);
  const [shortOnly, setShortOnly] = useState(false);
  const [hidePast, setHidePast] = useState(true);
  const [hideMcmenamins, setHideMcmenamins] = useState(false);
  const [hideUnverified, setHideUnverified] = useState(false);
  const [venuesOpen, setVenuesOpen] = useState(false);
  const [genresOpen, setGenresOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [filtersVisible, setFiltersVisible] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPosterModal(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("viewMode");
    if (saved === "compact" || saved === "expanded") setViewMode(saved);

    fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/upcoming.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Schedule>;
      })
      .then((data) => {
        setSchedule(data);
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

        const start = data.window.start;
        setSelectedDate(today >= start ? today : start);
      })
      .catch((e) => setError(String(e)));
  }, []);

  function toggleViewMode() {
    setViewMode((prev) => {
      const next = prev === "expanded" ? "compact" : "expanded";
      localStorage.setItem("viewMode", next);
      return next;
    });
  }

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  // Date picker offers today + the next 6 days (7 total), never past dates and
  // never beyond the scraped window. window.start can lag behind today when the
  // data is from an earlier scrape, so anchor on whichever is later.
  const DATE_WINDOW_DAYS = 7;
  const dates = useMemo(() => {
    if (!schedule) return [];
    const start = today > schedule.window.start ? today : schedule.window.start;
    return buildDateWindow(start, schedule.window.end).slice(0, DATE_WINDOW_DAYS);
  }, [schedule, today]);

  // Build Fuse index once per schedule load. Denormalize venue names into each entry
  // so searches like "living room" or "omsi" work.
  const fuse = useMemo(() => {
    if (!schedule) return null;
    const venueMap = Object.fromEntries(schedule.venues.map((v) => [v.id, v.name]));
    const entries = schedule.films.map((film) => ({
      film,
      venueNames: [...new Set(film.showtimes.map((s) => venueMap[s.venue_id] ?? s.venue_id))],
    }));
    return new Fuse(entries, {
      keys: [
        { name: "film.title",    weight: 4 },
        { name: "film.genres",   weight: 2 },
        { name: "venueNames",    weight: 1.5 },
        { name: "film.director", weight: 1 },
      ],
      threshold: 0.2,
      ignoreLocation: true,
      minMatchCharLength: 3,
      includeMatches: true,
    });
  }, [schedule]);

  // Films matching search + genre only — the shared baseline the toggle filters
  // (matinee, <2h, hide past, hide McMenamins, hide unverified) all narrow further.
  const { searchedFilms, matchMap } = useMemo(() => {
    if (!schedule) return { searchedFilms: [] as Film[], matchMap: null as Map<string, FuseResultMatch[]> | null };
    const trimmed = query.trim();
    const fuseResults = trimmed && fuse ? fuse.search(trimmed) : null;
    const matchMap = fuseResults ? buildMatchMap(fuseResults) : null;
    const matchedSlugs = matchMap ? new Set(matchMap.keys()) : null;

    const searchedFilms = schedule.films
      .filter((film) => !matchedSlugs || matchedSlugs.has(film.slug))
      .filter((film) =>
        genreFilter.size === 0 ||
        film.genres.length === 0 ||
        film.genres.some((g) => genreFilter.has(g))
      );
    return { searchedFilms, matchMap };
  }, [schedule, query, fuse, genreFilter]);

  interface ToggleFlags {
    matineeOnly: boolean;
    shortOnly: boolean;
    hidePast: boolean;
    hideMcmenamins: boolean;
    hideUnverified: boolean;
  }

  // Counts how many showtimes on selectedDate survive a given combination of
  // toggle filters, on top of the search/genre/venue baseline.
  const countShowtimes = (films: Film[], flags: ToggleFlags): number => {
    const now = new Date();
    return films
      .filter((film) => !flags.shortOnly || film.runtime_minutes == null || film.runtime_minutes <= 120)
      .filter((film) => !flags.hideUnverified || film.id != null)
      .reduce((sum, film) => {
        const count = film.showtimes.filter((s) => {
          if (!s.datetime.startsWith(selectedDate)) return false;
          if (selectedVenues.size > 0 && !selectedVenues.has(s.venue_id)) return false;
          if (flags.hideMcmenamins && MCMENAMINS_IDS.has(s.venue_id)) return false;
          if (flags.hidePast && selectedDate === today && new Date(s.datetime) < now) return false;
          if (flags.matineeOnly && s.datetime.slice(11, 16) >= MATINEE_CUTOFF) return false;
          return true;
        }).length;
        return sum + count;
      }, 0);
  };

  const currentFlags: ToggleFlags = { matineeOnly, shortOnly, hidePast, hideMcmenamins, hideUnverified };

  // Count next to each toggle button: for "show only" toggles (Matinee, <2h) this is
  // how many showtimes qualify; for "hide" toggles this is how many would be removed.
  // Both are computed against the other toggles' current state.
  const toggleCounts = useMemo(() => {
    const matches = (flag: keyof ToggleFlags) =>
      countShowtimes(searchedFilms, { ...currentFlags, [flag]: true });
    const baseline = countShowtimes(searchedFilms, currentFlags);
    const removedBy = (flag: keyof ToggleFlags) => baseline - matches(flag);
    return {
      matineeOnly: matches("matineeOnly"),
      shortOnly: matches("shortOnly"),
      hidePast: removedBy("hidePast"),
      hideMcmenamins: removedBy("hideMcmenamins"),
      hideUnverified: removedBy("hideUnverified"),
    };
  }, [searchedFilms, selectedDate, selectedVenues, today, matineeOnly, shortOnly, hidePast, hideMcmenamins, hideUnverified]);

  const filmsOnDate = useMemo(() => {
    if (!schedule || !selectedDate) return [];

    const entries = searchedFilms
      // Runtime filter
      .filter((film) => !shortOnly || film.runtime_minutes == null || film.runtime_minutes <= 120)
      // Verification filter: films we couldn't match to a movie database entry
      .filter((film) => !hideUnverified || film.id != null)
      .map((film) => {
        const now = new Date();
        let showtimes = film.showtimes.filter((s) => {
          if (!s.datetime.startsWith(selectedDate)) return false;
          if (selectedVenues.size > 0 && !selectedVenues.has(s.venue_id)) return false;
          if (hideMcmenamins && MCMENAMINS_IDS.has(s.venue_id)) return false;
          if (hidePast && selectedDate === today && new Date(s.datetime) < now) return false;
          return true;
        });
        // Matinee filter: restrict to showtimes before cutoff
        if (matineeOnly) {
          showtimes = showtimes.filter((s) => s.datetime.slice(11, 16) < MATINEE_CUTOFF);
        }
        return { film, showtimes, matches: matchMap?.get(film.slug) ?? [] };
      })
      .filter(({ showtimes }) => showtimes.length > 0);

    // Deduplicate by TMDB id (same film may appear under two titles before re-scrape)
    const deduped = new Map<string | number, { film: Film; showtimes: Showtime[]; matches: FuseResultMatch[] }>();
    for (const entry of entries) {
      const key = entry.film.id ?? entry.film.slug;
      if (!deduped.has(key)) {
        deduped.set(key, { ...entry, showtimes: [...entry.showtimes] });
      } else {
        const existing = deduped.get(key)!;
        existing.showtimes.push(...entry.showtimes);
        // A verified match on any title for this film outweighs a fallback
        // match on another — the fallback guess is now cross-confirmed.
        if (existing.film.match_confidence === "fallback" && entry.film.match_confidence === "verified") {
          existing.film = entry.film;
        }
      }
    }

    return [...deduped.values()].sort((a, b) => {
      if (sortBy === "title") return a.film.title.localeCompare(b.film.title);
      if (sortBy === "runtime") {
        const aR = a.film.runtime_minutes ?? 0;
        const bR = b.film.runtime_minutes ?? 0;
        return aR - bR;
      }
      const aMin = a.showtimes[0].datetime;
      const bMin = b.showtimes[0].datetime;
      return aMin < bMin ? -1 : aMin > bMin ? 1 : 0;
    });
  }, [schedule, selectedDate, selectedVenues, searchedFilms, matchMap, matineeOnly, shortOnly, hidePast, hideMcmenamins, hideUnverified, today, sortBy]);

  // Total showtimes on this date, regardless of filters, vs. how many survive them.
  const showtimeCounts = useMemo(() => {
    if (!schedule || !selectedDate) return { total: 0, shown: 0 };
    const total = schedule.films.reduce(
      (sum, film) => sum + film.showtimes.filter((s) => s.datetime.startsWith(selectedDate)).length,
      0
    );
    const shown = filmsOnDate.reduce((sum, { showtimes }) => sum + showtimes.length, 0);
    return { total, shown };
  }, [schedule, selectedDate, filmsOnDate]);

  // Whether today's showtimes have all already passed (vs. there being none at all).
  // Only relevant when filmsOnDate is empty, we're on today, and "Hide past" is on.
  const allShowtimesPassedToday =
    filmsOnDate.length === 0 &&
    selectedDate === today &&
    hidePast &&
    !!schedule &&
    schedule.films.some((film) =>
      film.showtimes.some((s) => {
        if (!s.datetime.startsWith(selectedDate)) return false;
        if (selectedVenues.size > 0 && !selectedVenues.has(s.venue_id)) return false;
        if (hideMcmenamins && MCMENAMINS_IDS.has(s.venue_id)) return false;
        if (matineeOnly && s.datetime.slice(11, 16) >= MATINEE_CUTOFF) return false;
        return true;
      })
    );

  const nextDate = useMemo(() => {
    const idx = dates.indexOf(selectedDate);
    return idx >= 0 && idx + 1 < dates.length ? dates[idx + 1] : null;
  }, [dates, selectedDate]);

  // Genres that have at least one showtime on the selected date+venues (ignoring genre filter)
  const availableGenres = useMemo(() => {
    if (!schedule) return new Set<string>();
    return new Set(
      schedule.films
        .filter((f) => f.showtimes.some((s) => s.datetime.startsWith(selectedDate) && (selectedVenues.size === 0 || selectedVenues.has(s.venue_id))))
        .flatMap((f) => f.genres)
    );
  }, [schedule, selectedDate, selectedVenues]);

  // Venues that have at least one showtime on the selected date (ignoring venue filter)
  const availableVenueIds = useMemo(() => {
    if (!schedule) return new Set<string>();
    return new Set(
      schedule.films.flatMap((f) => f.showtimes).filter((s) => s.datetime.startsWith(selectedDate)).map((s) => s.venue_id)
    );
  }, [schedule, selectedDate]);

  const allGenres = useMemo(
    () => (schedule ? [...new Set(schedule.films.flatMap((f) => f.genres))].sort() : []),
    [schedule]
  );

  function toggleVenue(id: string) {
    setSelectedVenues((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (error) {
    return <div className={styles.error}>Failed to load schedule: {error}</div>;
  }
  if (!schedule) {
    return <div className={styles.loading}>Loading…</div>;
  }

  const allSelected = selectedVenues.size === 0;
  const notMcmenaminsIds = new Set(schedule.venues.map((v) => v.id).filter((id) => !MCMENAMINS_IDS.has(id)));
  const notMcmenaminsActive =
    selectedVenues.size === notMcmenaminsIds.size &&
    [...selectedVenues].every((id) => notMcmenaminsIds.has(id));

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Small Screens PDX</h1>
        <p className={styles.subtitle}>Independent cinema in Portland</p>
      </header>

      <div className={styles.filters}>
        {/* Date picker: 7 calendar-day cards spanning the full width */}
        <div className={styles.dateCards}>
          {dates.map((d) => {
            const { weekday, month, day } = formatDayCardLabel(d);
            const isToday = d === today;
            return (
              <button
                key={d}
                className={`${styles.dateCard} ${d === selectedDate ? styles.dateCardActive : ""} ${isToday ? styles.dateCardToday : ""}`}
                onClick={() => setSelectedDate(d)}
              >
                <span className={styles.dateCardMonth}>{month}</span>
                <span className={styles.dateCardDay}>{day}</span>
                <span className={styles.dateCardWeekday}>{isToday ? "Today" : weekday}</span>
              </button>
            );
          })}
        </div>

        {/* Quick toggles + view mode */}
        <div className={styles.filterRow}>
          {/*
          <div className={styles.dateSelectWrapper}>
          <select
            className={styles.dateSelect}
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          >
            {dates.map((d) => (
              <option key={d} value={d}>
                {formatDateLabel(d, today)}
              </option>
            ))}
          </select>
          </div>
          */}
          <button
            className={`${styles.toggleBtn} ${matineeOnly ? styles.toggleBtnActive : ""}`}
            onClick={() => setMatineeOnly((v) => !v)}
            title="Show only showtimes before 5pm"
          >
            Matinee <span className={styles.toggleCount}>({toggleCounts.matineeOnly})</span>
          </button>
          <button
            className={`${styles.toggleBtn} ${shortOnly ? styles.toggleBtnActive : ""}`}
            onClick={() => setShortOnly((v) => !v)}
            title="Show only films under 2 hours"
          >
            &lt; 2h <span className={styles.toggleCount}>({toggleCounts.shortOnly})</span>
          </button>
          <button
            className={`${styles.toggleBtn} ${hidePast ? styles.toggleBtnActive : ""}`}
            onClick={() => setHidePast((v) => !v)}
            title="Hide showtimes that have already started"
          >
            Hide past <span className={styles.toggleCount}>({toggleCounts.hidePast})</span>
          </button>
          <button
            className={`${styles.toggleBtn} ${hideMcmenamins ? styles.toggleBtnActive : ""}`}
            onClick={() => setHideMcmenamins((v) => !v)}
            title="Hide showtimes at McMenamins venues (Bagdad, Kennedy School, Mission)"
          >
            Hide McMenamins <span className={styles.toggleCount}>({toggleCounts.hideMcmenamins})</span>
          </button>
          <button
            className={`${styles.toggleBtn} ${hideUnverified ? styles.toggleBtnActive : ""}`}
            onClick={() => setHideUnverified((v) => !v)}
            title="Some showtimes can't be matched to a movie database entry — they're still real screenings, just without poster art or details. Hide them here if you'd rather only see verified listings."
          >
            Hide unverified <span className={styles.toggleCount}>({toggleCounts.hideUnverified})</span>
          </button>
          <button
            className={`${styles.toggleBtn} ${filtersVisible ? styles.toggleBtnActive : ""} ${(query || selectedVenues.size > 0 || genreFilter.size > 0) && !filtersVisible ? styles.toggleBtnDot : ""}`}
            onClick={() => setFiltersVisible((v) => !v)}
            title={filtersVisible ? "Hide search and filters" : "Show search and filters"}
          >
            {filtersVisible ? "Hide filters" : "Show more filters"}
          </button>
        </div>

        <div className={`${styles.filtersPanel} ${filtersVisible ? styles.filtersPanelOpen : ""}`}>
        <div className={styles.filtersPanelInner}>
        {/* Search */}
        <div className={styles.searchRow}>
          <input
            className={styles.searchInput}
            type="search"
            placeholder="Search films, genres, directors, venues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className={styles.searchClear} onClick={() => setQuery("")} aria-label="Clear search">
              ✕
            </button>
          )}
        </div>

        {/* Venue filter — collapsible */}
        <div className={styles.collapsible}>
          <button className={styles.collapsibleToggle} onClick={() => setVenuesOpen((o) => !o)}>
            <span className={styles.collapsibleCaret}>{venuesOpen ? "▲" : "▼"}</span>
            <span className={styles.collapsibleLabel}>
              Venue
              {selectedVenues.size > 0 && (
                <>
                  <span className={styles.collapsibleSummary}>
                    {notMcmenaminsActive
                      ? "Not McMenamins"
                      : [...selectedVenues].map((id) => schedule.venues.find((v) => v.id === id)?.name).filter(Boolean).join(", ")}
                  </span>
                  <span
                    className={styles.clearFilter}
                    role="button"
                    tabIndex={0}
                    title="Clear venue filter"
                    onClick={(e) => { e.stopPropagation(); setSelectedVenues(new Set()); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setSelectedVenues(new Set()); } }}
                  >✕</span>
                </>
              )}
            </span>
          </button>
          {venuesOpen && (
            <div className={styles.chipGroup}>
              <button
                className={`${styles.venueChip} ${allSelected ? styles.venueChipActive : ""}`}
                onClick={() => setSelectedVenues(new Set())}
              >
                All
              </button>
              <button
                className={`${styles.venueChip} ${notMcmenaminsActive ? styles.venueChipActive : ""}`}
                onClick={() => setSelectedVenues(new Set(notMcmenaminsIds))}
              >
                Not McMenamins
              </button>
              {schedule.venues.map((v) => {
                const unavailable = !availableVenueIds.has(v.id);
                return (
                  <button
                    key={v.id}
                    className={`${styles.venueChip} ${!allSelected && selectedVenues.has(v.id) ? styles.venueChipActive : ""} ${unavailable ? styles.chipUnavailable : ""}`}
                    aria-disabled={unavailable}
                    title={unavailable ? "No showtimes at this venue today" : undefined}
                    onClick={() => !unavailable && toggleVenue(v.id)}
                  >
                    {v.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Genre filter — collapsible */}
        <div className={styles.collapsible}>
          <button className={styles.collapsibleToggle} onClick={() => setGenresOpen((o) => !o)}>
            <span className={styles.collapsibleCaret}>{genresOpen ? "▲" : "▼"}</span>
            <span className={styles.collapsibleLabel}>
              Genre
              {genreFilter.size > 0 && (
                <>
                  <span className={styles.collapsibleSummary}>{[...genreFilter].join(", ")}</span>
                  <span
                    className={styles.clearFilter}
                    role="button"
                    tabIndex={0}
                    title="Clear genre filter"
                    onClick={(e) => { e.stopPropagation(); setGenreFilter(new Set()); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setGenreFilter(new Set()); } }}
                  >✕</span>
                </>
              )}
            </span>
          </button>
          {genresOpen && (
            <div className={styles.chipGroup}>
              <button
                className={`${styles.venueChip} ${genreFilter.size === 0 ? styles.venueChipActive : ""}`}
                onClick={() => setGenreFilter(new Set())}
              >
                All
              </button>
              {allGenres.map((g) => {
                const unavailable = !availableGenres.has(g);
                return (
                  <button
                    key={g}
                    className={`${styles.venueChip} ${genreFilter.has(g) ? styles.venueChipActive : ""} ${unavailable ? styles.chipUnavailable : ""}`}
                    aria-disabled={unavailable}
                    title={unavailable ? "No movies in this genre currently" : undefined}
                    onClick={() => {
                      if (unavailable) return;
                      setGenreFilter((prev) => {
                        const next = new Set(prev);
                        next.has(g) ? next.delete(g) : next.add(g);
                        return next;
                      });
                    }}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        </div></div>

        {/* Map — collapsible */}
        <div className={styles.collapsible}>
          <button className={styles.collapsibleToggle} onClick={() => setMapOpen((o) => !o)}>
            <span className={styles.collapsibleCaret}>{mapOpen ? "▲" : "▼"}</span>
            <span className={styles.collapsibleLabel}>
              <svg className={styles.mapIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
                <line x1="8" y1="2" x2="8" y2="18" />
                <line x1="16" y1="6" x2="16" y2="22" />
              </svg>
              See venues on map ({schedule.venues.length})
            </span>
          </button>
          {mapOpen && (
            <VenueMap
              venues={schedule.venues}
              selectedVenues={selectedVenues}
              onVenueClick={(id) => {
                setSelectedVenues(new Set([id]));
                setFiltersVisible(true);
              }}
            />
          )}
        </div>

        <h2 className={styles.resultsHeading}>
          Showtimes {formatFullDateLabel(selectedDate)}
          {showtimeCounts.total > 0 && (
            <span className={styles.resultsCounts}>
              {" "}({showtimeCounts.shown} shown, {showtimeCounts.total - showtimeCounts.shown} filtered out)
            </span>
          )}
        </h2>

        {/* Sort */}
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>Sort</span>
          <div className={styles.chipGroup}>
            <button className={`${styles.venueChip} ${sortBy === "time" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("time")}>By time</button>
            <button className={`${styles.venueChip} ${sortBy === "title" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("title")}>A–Z</button>
            <button className={`${styles.venueChip} ${sortBy === "runtime" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("runtime")}>Runtime</button>
            <button className={`${styles.venueChip} ${styles.chipUnavailable}`} aria-disabled title="Coming soon — Rotten Tomatoes integration planned">RT Score</button>
          </div>
          <button
            className={styles.viewToggle}
            style={{ marginLeft: "auto" }}
            onClick={toggleViewMode}
            title={viewMode === "expanded" ? "Switch to compact view" : "Switch to expanded view"}
          >
            {viewMode === "expanded" ? "Compact" : "Expanded"}
          </button>
        </div>
      </div>


      <main className={styles.main}>
        {filmsOnDate.length === 0 ? (
          <div className={styles.empty}>
            {allShowtimesPassedToday && nextDate ? (
              <>
                No more showtimes today.{" "}
                <button className={styles.viewTomorrowLink} onClick={() => setSelectedDate(nextDate)}>
                  View {formatDateLabel(nextDate, today).toLowerCase()}
                </button>
              </>
            ) : (
              "No showtimes for this date."
            )}
          </div>
        ) : (
          <div className={styles.filmList}>
            {filmsOnDate.map(({ film, showtimes, matches }) => (
              <FilmRow
                key={film.id ?? film.slug}
                film={film}
                showtimes={showtimes}
                venues={schedule.venues}
                viewMode={viewMode}
                fuseMatches={matches}
                onVenueClick={(id) => { setSelectedVenues(new Set([id])); setFiltersVisible(true); }}
                onGenreClick={(g) => { setGenreFilter(new Set([g])); setFiltersVisible(true); }}
                onPosterClick={(src, title) => setPosterModal({ src, title })}
              />
            ))}
          </div>
        )}
      </main>

      <footer className={styles.footer}>
        <p>
          Data from {schedule.venues.length} venues · Updated{" "}
          {new Date(schedule.generated_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
        <p>
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Movie data from TMDB
          </a>
        </p>
      </footer>

      {posterModal && (
        <div className={styles.modalOverlay} onClick={() => setPosterModal(null)}>
          <img
            className={styles.modalPoster}
            src={posterModal.src}
            alt={`${posterModal.title} poster`}
          />
        </div>
      )}
    </div>
  );
}

const REPORT_REPO = "mattlohkamp/small-screens-pdx";

function reportMatchIssueUrl(film: Film, kind: "unverified" | "mismatch"): string {
  const title = encodeURIComponent(
    kind === "unverified" ? `Unmatched listing: "${film.title}"` : `Possible mismatch: "${film.title}"`
  );
  const body = encodeURIComponent(
    `Scraped title: ${film.title}\n` +
      (kind === "mismatch"
        ? `Currently matched to: ${film.title} (TMDB ID ${film.id})\nWhat's wrong: <describe the correct film here>\n`
        : `This listing couldn't be matched to a movie database entry at all.\n`)
  );
  return `https://github.com/${REPORT_REPO}/issues/new?title=${title}&body=${body}&labels=match-feedback`;
}

// Flags a film's match quality: unmatched entirely, or matched via a fallback
// guess (title had event flair stripped before searching) worth a second look.
function MatchBadge({ film, className }: { film: Film; className: string }) {
  if (film.id == null) {
    return (
      <a
        className={className}
        href={reportMatchIssueUrl(film, "unverified")}
        target="_blank"
        rel="noopener noreferrer"
        title="We couldn't match this listing to a movie database entry — it's still a real screening, just without poster art or details. Click to report if you recognize this film."
      >
        Unverified
      </a>
    );
  }
  if (film.match_confidence === "fallback") {
    return (
      <a
        className={`${className} ${styles.possibleMismatchBadge}`}
        href={reportMatchIssueUrl(film, "mismatch")}
        target="_blank"
        rel="noopener noreferrer"
        title="This listing's title didn't match directly — we guessed the film after stripping off extra event wording. Click to report if this looks wrong."
      >
        Possible mismatch
      </a>
    );
  }
  return null;
}

function extractMatches(fuseMatches: FuseResultMatch[]): FilmMatches {
  const title: MatchIndices = fuseMatches.find((m) => m.key === "film.title")?.indices ?? [];
  const director: MatchIndices = fuseMatches.find((m) => m.key === "film.director")?.indices ?? [];
  const genres = new Map<string, MatchIndices>();
  for (const m of fuseMatches.filter((m) => m.key === "film.genres")) {
    if (m.value) genres.set(m.value, m.indices ?? []);
  }
  return { title, director, genres };
}

function FilmRow({
  film,
  showtimes,
  venues,
  viewMode,
  fuseMatches,
  onVenueClick,
  onGenreClick,
  onPosterClick,
}: {
  film: Film;
  showtimes: Showtime[];
  venues: Venue[];
  viewMode: ViewMode;
  fuseMatches: FuseResultMatch[];
  onVenueClick: (venueId: string) => void;
  onGenreClick: (genre: string) => void;
  onPosterClick: (src: string, title: string) => void;
}) {
  const matches = useMemo(() => extractMatches(fuseMatches), [fuseMatches]);
  const venueMap = useMemo(
    () => Object.fromEntries(venues.map((v) => [v.id, v])),
    [venues]
  );

  const byVenue = useMemo(() => {
    const map = new Map<string, Showtime[]>();
    for (const s of showtimes) {
      if (!map.has(s.venue_id)) map.set(s.venue_id, []);
      map.get(s.venue_id)!.push(s);
    }
    return map;
  }, [showtimes]);

  const posterUrl = film.poster_path
    ? `https://image.tmdb.org/t/p/w154${film.poster_path}`
    : null;

  if (viewMode === "compact") {
    return (
      <article className={styles.filmRowCompact}>
        <div className={styles.filmMetaCompact}>
          <span className={styles.filmTitleCompact}>{highlightText(film.title, matches.title)}</span>
          <MatchBadge film={film} className={styles.unverifiedBadge} />
          {film.year && <span className={styles.filmYearCompact}>{film.year}</span>}
          {film.director && <span className={styles.filmDirectorCompact}>dir. {highlightText(film.director, matches.director)}</span>}
          {film.runtime_minutes && <span className={styles.filmYearCompact}>{formatRuntime(film.runtime_minutes)}</span>}
        </div>
        <div className={styles.showtimesCompact}>
          {[...byVenue.entries()].map(([venueId, times]) => (
            <span key={venueId} className={styles.venueBlockCompact}>
              <button
                className={styles.venueNameCompact}
                onClick={() => onVenueClick(venueId)}
                title="View all from this venue"
              >
                {venueMap[venueId]?.name ?? venueId}
              </button>
              {venueMap[venueId] && (
                <a
                  className={styles.venueFilmLink}
                  href={buildFilmPageUrl(venueId, film, venueMap[venueId])}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on venue website"
                >🎟&#xFE0E;↗</a>
              )}
              {times
                .sort((a, b) => (a.datetime < b.datetime ? -1 : 1))
                .map((s) => (
                  <a
                    key={s.datetime}
                    href={s.ticket_url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.timeLinkCompact}
                  >
                    {formatTime(s.datetime)}
                    {s.format && s.format.toUpperCase() !== "DCP" && <span className={styles.format}> (format: {s.format})</span>}
                    {s.event_note && (
                      <span className={styles.eventNote} title={`Special showing: ${s.event_note}`}> · {s.event_note}</span>
                    )}
                  </a>
                ))}
            </span>
          ))}
        </div>
      </article>
    );
  }

  return (
    <article className={styles.filmRow}>
      {posterUrl ? (
        <img
          className={`${styles.poster} ${styles.posterClickable}`}
          src={posterUrl}
          alt={`${film.title} poster`}
          width={77}
          height={116}
          loading="lazy"
          onClick={() => onPosterClick(`https://image.tmdb.org/t/p/w500${film.poster_path}`, film.title)}
          title="View full poster"
        />
      ) : (
        <div className={styles.posterPlaceholder} />
      )}

      <div className={styles.filmInfo}>
        <div className={styles.filmMeta}>
          <h2 className={styles.filmTitle}>
            <a
              href={imdbUrl(film)}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.filmTitleLink}
            >
              {highlightText(film.title, matches.title)}
            </a>
          </h2>
          <MatchBadge film={film} className={styles.unverifiedBadge} />
          <span className={styles.filmYear}>{film.year}</span>
          {film.director && (
            <span className={styles.filmDirector}>dir. {highlightText(film.director, matches.director)}</span>
          )}
          {film.runtime_minutes && (
            <span className={styles.filmRuntime}>{formatRuntime(film.runtime_minutes)}</span>
          )}
        </div>

        {film.genres.length > 0 && (
          <div className={styles.genres}>
            {film.genres.map((g) => (
              <button
                key={g}
                className={styles.genre}
                onClick={() => onGenreClick(g)}
                title="View only this genre"
              >
                {highlightText(g, matches.genres.get(g) ?? [])}
              </button>
            ))}
          </div>
        )}

        <div className={styles.showtimesByVenue}>
          {[...byVenue.entries()].map(([venueId, times]) => (
            <div key={venueId} className={styles.venueShowtimes}>
              <span className={styles.venueNameGroup}>
                <button
                  className={styles.venueName}
                  onClick={() => onVenueClick(venueId)}
                  title="View all from this venue"
                >
                  {venueMap[venueId]?.name ?? venueId}
                </button>
                {venueMap[venueId] && (
                  <a
                    className={styles.venueFilmLink}
                    href={buildFilmPageUrl(venueId, film, venueMap[venueId])}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on venue website"
                  >🎟&#xFE0E;↗</a>
                )}
              </span>
              <div className={styles.times}>
                {times
                  .sort((a, b) => (a.datetime < b.datetime ? -1 : 1))
                  .map((s) => (
                    <a
                      key={s.datetime}
                      href={s.ticket_url ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.timeLink}
                    >
                      {formatTime(s.datetime)}
                      {s.format && s.format.toUpperCase() !== "DCP" && (
                        <span className={styles.format}> (format: {s.format})</span>
                      )}
                      {s.event_note && (
                        <span className={styles.eventNote} title={`Special showing: ${s.event_note}`}> · {s.event_note}</span>
                      )}
                    </a>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
