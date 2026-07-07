"use client";

import { useEffect, useState, useMemo } from "react";
import Fuse, { type FuseResult, type FuseResultMatch } from "fuse.js";
import styles from "./WhatsOn.module.css";

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
  rt_score?: number | null;
  imdb_rating?: number | null;
  metacritic_score?: number | null;
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

// OMDb gives us the score but not a page slug, so link to each site's search.
function rtSearchUrl(film: Film): string {
  return `https://www.rottentomatoes.com/search?search=${encodeURIComponent(film.title)}`;
}

function metacriticSearchUrl(film: Film): string {
  return `https://www.metacritic.com/search/${encodeURIComponent(film.title)}/`;
}

// Renders whichever of the three OMDb-sourced ratings (RT critics, IMDb
// audience, Metacritic critics) are present — any or all may be missing if
// OMDb has no entry for this title.
function RatingsBadges({ film, className }: { film: Film; className: string }) {
  const badges: React.ReactNode[] = [];

  if (film.rt_score != null) {
    const fresh = film.rt_score >= 60;
    badges.push(
      <a
        key="rt"
        className={`${className} ${fresh ? styles.rtScoreFresh : styles.rtScoreRotten}`}
        href={rtSearchUrl(film)}
        target="_blank"
        rel="noopener noreferrer"
        title="Rotten Tomatoes score (critics)"
      >
        {fresh ? "🍅" : "🤢"} {film.rt_score}%
      </a>
    );
  }

  if (film.imdb_rating != null) {
    badges.push(
      <a
        key="imdb"
        className={`${className} ${styles.imdbRating}`}
        href={imdbUrl(film)}
        target="_blank"
        rel="noopener noreferrer"
        title="IMDb rating (audience)"
      >
        ★ {film.imdb_rating.toFixed(1)}
      </a>
    );
  }

  if (film.metacritic_score != null) {
    const tier =
      film.metacritic_score >= 61 ? styles.metacriticHigh
      : film.metacritic_score >= 40 ? styles.metacriticMid
      : styles.metacriticLow;
    badges.push(
      <a
        key="mc"
        className={`${className} ${tier}`}
        href={metacriticSearchUrl(film)}
        target="_blank"
        rel="noopener noreferrer"
        title="Metacritic score (critics)"
      >
        Ⓜ {film.metacritic_score}
      </a>
    );
  }

  // Matched films (a real TMDB/IMDb ID) with none of the three ratings — often
  // just-released titles OMDb hasn't caught up on yet — get a plain note instead
  // of silently showing nothing, so it reads as "not rated yet" not "we forgot".
  if (badges.length === 0 && film.id != null) {
    return <span className={styles.ratingsUnavailable}>Ratings unavailable</span>;
  }

  return <>{badges}</>;
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

// "Today" as a Portland calendar date, matching how the scraper builds the
// window and the Portland-local showtime datetimes. Anchoring to Portland (not
// the viewer's device timezone) keeps out-of-town viewers lined up with the data.
const TIMEZONE = "America/Los_Angeles";
function portlandToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
}

type ViewMode = "expanded" | "compact";
type SortBy = "time" | "title" | "runtime" | "score";

// Averages whichever of the three OMDb ratings are present, normalizing IMDb's
// 0-10 scale up to 0-100 so it doesn't get outweighed by RT/Metacritic. Null
// when none are present — e.g. brand-new releases OMDb hasn't caught up on yet.
function compositeScore(film: Film): number | null {
  const parts: number[] = [];
  if (film.rt_score != null) parts.push(film.rt_score);
  if (film.imdb_rating != null) parts.push(film.imdb_rating * 10);
  if (film.metacritic_score != null) parts.push(film.metacritic_score);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

const MATINEE_CUTOFF = "17:00"; // before 5pm
const MCMENAMINS_IDS = new Set(["baghdad", "kennedy-school", "mission"]);

export default function WhatsOn() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posterModal, setPosterModal] = useState<{ src: string; title: string } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedVenues, setSelectedVenues] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("title");
  const [genreFilter, setGenreFilter] = useState<Set<string>>(new Set());
  const [matineeOnly, setMatineeOnly] = useState(false);
  const [shortOnly, setShortOnly] = useState(false);
  const [hidePast, setHidePast] = useState(true);
  const [hideUnverified, setHideUnverified] = useState(false);
  // Desktop only: search + venue + genre collapse behind a "Show more filters"
  // toggle (collapsed by default). On mobile they're always shown in the drawer.
  const [filtersVisible, setFiltersVisible] = useState(false);
  // Mobile only: the whole control block lives in a top drawer that overlays the
  // film list as a modal. Closed, it retracts to a circular pull-tab; open, it
  // slides down over a dimmed backdrop. Desktop keeps the sticky header.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Tracks the mobile breakpoint so view mode can be forced by viewport (compact
  // on mobile, expanded on desktop) rather than exposed as a toggle everywhere.
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setPosterModal(null);
        setDrawerOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 570px)");
    const update = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setDrawerOpen(false); // leaving mobile: close the drawer
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Lock background scroll while the drawer is open, like a modal.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/showtimes.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Schedule>;
      })
      .then((data) => {
        setSchedule(data);
        const today = portlandToday();
        const start = data.window.start;
        setSelectedDate(today >= start ? today : start);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const today = useMemo(() => portlandToday(), []);
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
          if (flags.hidePast && selectedDate === today && new Date(s.datetime) < now) return false;
          if (flags.matineeOnly && s.datetime.slice(11, 16) >= MATINEE_CUTOFF) return false;
          return true;
        }).length;
        return sum + count;
      }, 0);
  };

  const currentFlags: ToggleFlags = { matineeOnly, shortOnly, hidePast, hideUnverified };

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
      hideUnverified: removedBy("hideUnverified"),
    };
  }, [searchedFilms, selectedDate, selectedVenues, today, matineeOnly, shortOnly, hidePast, hideUnverified]);

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
      if (sortBy === "score") {
        // Unrated films sort first — often just-released titles OMDb hasn't
        // caught up on yet, not necessarily worse than rated ones — then
        // descending by composite score.
        const aScore = compositeScore(a.film);
        const bScore = compositeScore(b.film);
        if (aScore == null && bScore == null) return a.film.title.localeCompare(b.film.title);
        if (aScore == null) return -1;
        if (bScore == null) return 1;
        return bScore - aScore;
      }
      const aMin = a.showtimes[0].datetime;
      const bMin = b.showtimes[0].datetime;
      return aMin < bMin ? -1 : aMin > bMin ? 1 : 0;
    });
  }, [schedule, selectedDate, selectedVenues, searchedFilms, matchMap, matineeOnly, shortOnly, hidePast, hideUnverified, today, sortBy]);

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
  // View mode is dictated entirely by viewport: compact on mobile, expanded on
  // desktop. No user-facing toggle.
  const effectiveViewMode: ViewMode = isMobile ? "compact" : "expanded";
  // Mobile always shows the full filter set (in the drawer); desktop hides
  // search/venue/genre behind the "Show more filters" toggle.
  const showFilters = isMobile || filtersVisible;
  const shortSelectedDate = selectedDate
    ? new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : "";
  const filteredOut = showtimeCounts.total - showtimeCounts.shown;
  const notMcmenaminsIds = new Set(schedule.venues.map((v) => v.id).filter((id) => !MCMENAMINS_IDS.has(id)));
  const notMcmenaminsActive =
    selectedVenues.size === notMcmenaminsIds.size &&
    [...selectedVenues].every((id) => notMcmenaminsIds.has(id));

  return (
    <div className={`${styles.root} ${drawerOpen ? styles.rootDrawerOpen : ""}`}>
      {/* Modal backdrop behind the open drawer — dims the site and closes on tap. */}
      {drawerOpen && (
        <div
          className={styles.drawerBackdrop}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <div
        id="filters-drawer"
        className={`${styles.filtersDrawer} ${drawerOpen ? styles.filtersDrawerOpen : ""}`}
      >
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

        {/* Quick toggle pills */}
        <div className={`${styles.filterRow} ${styles.toggleRow}`}>
          <button
            className={`${styles.venueChip} ${matineeOnly ? styles.venueChipActive : ""}`}
            onClick={() => setMatineeOnly((v) => !v)}
            title="Show only showtimes before 5pm"
          >
            Matinee <span className={styles.toggleCount}>({toggleCounts.matineeOnly})</span>
          </button>
          <button
            className={`${styles.venueChip} ${shortOnly ? styles.venueChipActive : ""}`}
            onClick={() => setShortOnly((v) => !v)}
            title="Show only films under 2 hours"
          >
            &lt; 2h <span className={styles.toggleCount}>({toggleCounts.shortOnly})</span>
          </button>
          <button
            className={`${styles.venueChip} ${hidePast ? styles.venueChipActive : ""}`}
            onClick={() => setHidePast((v) => !v)}
            title="Hide showtimes that have already started"
          >
            Hide past <span className={styles.toggleCount}>({toggleCounts.hidePast})</span>
          </button>
          <button
            className={`${styles.venueChip} ${hideUnverified ? styles.venueChipActive : ""}`}
            onClick={() => setHideUnverified((v) => !v)}
            title="Some showtimes can't be matched to a movie database entry — they're still real screenings, just without poster art or details. Hide them here if you'd rather only see verified listings."
          >
            Hide unverified <span className={styles.toggleCount}>({toggleCounts.hideUnverified})</span>
          </button>
          {/* Desktop only: gate search/venue/genre behind a collapse toggle. On
              mobile these always show in the drawer, so the toggle is pointless. */}
          {!isMobile && (
            <button
              className={`${styles.venueChip} ${filtersVisible ? styles.venueChipActive : ""} ${(query || selectedVenues.size > 0 || genreFilter.size > 0) && !filtersVisible ? styles.toggleBtnDot : ""}`}
              onClick={() => setFiltersVisible((v) => !v)}
              title={filtersVisible ? "Hide search and filters" : "Show search and filters"}
            >
              {filtersVisible ? "Hide filters" : "Show more filters"}
            </button>
          )}
        </div>

        {/* Search + venue + genre. On mobile always shown (in the drawer); on
            desktop collapsed behind "Show more filters" via the grid animation. */}
        <div className={`${styles.filtersPanel} ${showFilters ? styles.filtersPanelOpen : ""}`}>
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

        {/* Venue filter — always shown, no title/caret. The "All venues" chip is
            the (selected-by-default) clear-all. */}
        <div className={styles.chipGroup}>
          <button
            className={`${styles.venueChip} ${allSelected ? styles.venueChipActive : ""}`}
            onClick={() => setSelectedVenues(new Set())}
          >
            All venues
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

        {/* Genre filter — always shown, no title/caret. "All genres" is the
            (selected-by-default) clear-all. */}
        <div className={styles.chipGroup}>
          <button
            className={`${styles.venueChip} ${genreFilter.size === 0 ? styles.venueChipActive : ""}`}
            onClick={() => setGenreFilter(new Set())}
          >
            All genres
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
        </div>
        </div>

        {/* Results heading (left) + sort (right) share one row on desktop. */}
        <div className={styles.resultsBar}>
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
              <button className={`${styles.venueChip} ${sortBy === "title" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("title")}>A–Z</button>
              <button className={`${styles.venueChip} ${sortBy === "time" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("time")}>Showtime</button>
              <button className={`${styles.venueChip} ${sortBy === "runtime" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("runtime")}>Runtime</button>
              <button className={`${styles.venueChip} ${sortBy === "score" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("score")} title="Averages Rotten Tomatoes, IMDb, and Metacritic (whichever are available); unrated titles sort first">Score</button>
            </div>
          </div>
        </div>
      </div>
      {/* Mobile-only: the drawer's yellow bottom edge. Closed, it reads "MORE
          OPTIONS" (tap to open the filters); open, it becomes the live results
          summary (tap to collapse back to those results). */}
      <button
        className={styles.drawerBar}
        onClick={() => setDrawerOpen((o) => !o)}
        aria-expanded={drawerOpen}
        aria-controls="filters-drawer"
        aria-label={drawerOpen ? "Close options and view results" : "Show more options"}
      >
        {drawerOpen ? (
          <span className={styles.drawerBarCount}>
            {showtimeCounts.shown} {showtimeCounts.shown === 1 ? "showtime" : "showtimes"} for {shortSelectedDate}
            {filteredOut > 0 && ` (${filteredOut} filtered out)`}
          </span>
        ) : (
          <span className={styles.drawerBarLabel}>More options</span>
        )}
        <svg className={styles.drawerBarCaret} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {drawerOpen ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
        </svg>
      </button>
      </div>


      <main className={styles.main}>
        {filmsOnDate.length === 0 ? (
          <div className={styles.empty}>
            {allShowtimesPassedToday && nextDate ? (
              <>
                <span>No more showtimes today.</span>
                <button className={styles.viewTomorrowLink} onClick={() => setSelectedDate(nextDate)}>
                  View {formatDateLabel(nextDate, today).toLowerCase()}
                </button>
              </>
            ) : (
              <span>No showtimes for this date.</span>
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
                viewMode={effectiveViewMode}
                fuseMatches={matches}
                onVenueClick={(id) => setSelectedVenues(new Set([id]))}
                onGenreClick={(g) => setGenreFilter(new Set([g]))}
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
          {" · "}
          <a
            href="https://www.omdbapi.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Ratings from OMDb
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
          <RatingsBadges film={film} className={styles.ratingBadge} />
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
          <RatingsBadges film={film} className={styles.ratingBadge} />
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
