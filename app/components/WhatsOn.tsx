"use client";

import { useEffect, useState, useMemo } from "react";
import Fuse, { type FuseResultMatch } from "fuse.js";
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

function buildMatchMap(results: Fuse.FuseResult<{ film: { slug: string } }>[]): Map<string, FuseResultMatch[]> {
  const map = new Map<string, FuseResultMatch[]>();
  for (const r of results) {
    map.set(r.item.film.slug, r.matches ?? []);
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
  showtimes: Showtime[];
}

interface Schedule {
  generated_at: string;
  window: { start: string; end: string };
  venues: Venue[];
  films: Film[];
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
  if (dateStr === today) return "Today";
  const d = new Date(dateStr + "T12:00:00");
  const tomorrow = new Date(today + "T12:00:00");
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateStr === tomorrow.toISOString().slice(0, 10)) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
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

export default function WhatsOn() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedVenues, setSelectedVenues] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("expanded");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("time");
  const [genreFilter, setGenreFilter] = useState<Set<string>>(new Set());
  const [matineeOnly, setMatineeOnly] = useState(false);
  const [shortOnly, setShortOnly] = useState(false);
  const [venuesOpen, setVenuesOpen] = useState(false);
  const [genresOpen, setGenresOpen] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("viewMode");
    if (saved === "compact" || saved === "expanded") setViewMode(saved);

    fetch("/data/upcoming.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Schedule>;
      })
      .then((data) => {
        setSchedule(data);
        const today = new Date().toISOString().slice(0, 10);
        const start = data.window.start;
        setSelectedDate(today >= start ? today : start);
        setSelectedVenues(new Set(data.venues.map((v) => v.id)));
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

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const dates = useMemo(
    () => (schedule ? buildDateWindow(schedule.window.start, schedule.window.end) : []),
    [schedule]
  );

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

  const filmsOnDate = useMemo(() => {
    if (!schedule || !selectedDate) return [];

    const trimmed = query.trim();
    const fuseResults = trimmed && fuse ? fuse.search(trimmed) : null;
    const matchMap = fuseResults ? buildMatchMap(fuseResults) : null;
    const matchedSlugs = matchMap ? new Set(matchMap.keys()) : null;

    const entries = schedule.films
      .filter((film) => !matchedSlugs || matchedSlugs.has(film.slug))
      // Genre filter
      .filter((film) =>
        genreFilter.size === 0 || film.genres.some((g) => genreFilter.has(g))
      )
      // Runtime filter
      .filter((film) => !shortOnly || film.runtime_minutes == null || film.runtime_minutes <= 120)
      .map((film) => {
        let showtimes = film.showtimes.filter(
          (s) => s.datetime.startsWith(selectedDate) && selectedVenues.has(s.venue_id)
        );
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
        deduped.get(key)!.showtimes.push(...entry.showtimes);
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
  }, [schedule, selectedDate, selectedVenues, query, fuse, genreFilter, matineeOnly, shortOnly, sortBy]);

  // Genres that have at least one showtime on the selected date+venues (ignoring genre filter)
  const availableGenres = useMemo(() => {
    if (!schedule) return new Set<string>();
    return new Set(
      schedule.films
        .filter((f) => f.showtimes.some((s) => s.datetime.startsWith(selectedDate) && selectedVenues.has(s.venue_id)))
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
      if (next.has(id)) {
        if (next.size === 1) return prev; // keep at least one
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAllVenues() {
    if (!schedule) return;
    const allIds = new Set(schedule.venues.map((v) => v.id));
    if (selectedVenues.size === allIds.size) {
      setSelectedVenues(new Set([schedule.venues[0].id]));
    } else {
      setSelectedVenues(allIds);
    }
  }

  if (error) {
    return <div className={styles.error}>Failed to load schedule: {error}</div>;
  }
  if (!schedule) {
    return <div className={styles.loading}>Loading…</div>;
  }

  const allSelected = selectedVenues.size === schedule.venues.length;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Small Screens PDX</h1>
        <p className={styles.subtitle}>Independent cinema in Portland</p>
      </header>

      <div className={styles.filters}>
        {/* Date + quick toggles + view mode */}
        <div className={styles.filterRow}>
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
          <button
            className={`${styles.toggleBtn} ${matineeOnly ? styles.toggleBtnActive : ""}`}
            onClick={() => setMatineeOnly((v) => !v)}
            title="Show only showtimes before 5pm"
          >
            Matinee
          </button>
          <button
            className={`${styles.toggleBtn} ${shortOnly ? styles.toggleBtnActive : ""}`}
            onClick={() => setShortOnly((v) => !v)}
            title="Show only films under 2 hours"
          >
            &lt; 2h
          </button>
          <button
            className={styles.viewToggle}
            onClick={toggleViewMode}
            title={viewMode === "expanded" ? "Switch to compact view" : "Switch to expanded view"}
          >
            {viewMode === "expanded" ? "Compact" : "Expanded"}
          </button>
        </div>

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
            <span className={styles.collapsibleLabel}>
              Venue
              {!allSelected && (
                <span className={styles.collapsibleSummary}>
                  {[...selectedVenues].map((id) => schedule.venues.find((v) => v.id === id)?.name).filter(Boolean).join(", ")}
                </span>
              )}
            </span>
            <span className={styles.collapsibleCaret}>{venuesOpen ? "▲" : "▼"}</span>
          </button>
          {venuesOpen && (
            <div className={styles.chipGroup}>
              <button
                className={`${styles.venueChip} ${allSelected ? styles.venueChipActive : ""}`}
                onClick={toggleAllVenues}
              >
                All
              </button>
              {schedule.venues.map((v) => {
                const unavailable = !availableVenueIds.has(v.id);
                return (
                  <button
                    key={v.id}
                    className={`${styles.venueChip} ${selectedVenues.has(v.id) && !allSelected ? styles.venueChipActive : ""} ${unavailable ? styles.chipUnavailable : ""}`}
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
            <span className={styles.collapsibleLabel}>
              Genre
              {genreFilter.size > 0 && (
                <span className={styles.collapsibleSummary}>{[...genreFilter].join(", ")}</span>
              )}
            </span>
            <span className={styles.collapsibleCaret}>{genresOpen ? "▲" : "▼"}</span>
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

        {/* Sort */}
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>Sort</span>
          <div className={styles.chipGroup}>
            <button className={`${styles.venueChip} ${sortBy === "time" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("time")}>By time</button>
            <button className={`${styles.venueChip} ${sortBy === "title" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("title")}>A–Z</button>
            <button className={`${styles.venueChip} ${sortBy === "runtime" ? styles.venueChipActive : ""}`} onClick={() => setSortBy("runtime")}>Runtime</button>
            <button className={`${styles.venueChip} ${styles.chipUnavailable}`} aria-disabled title="Coming soon — Rotten Tomatoes integration planned">RT Score</button>
          </div>
        </div>
      </div>

      <main className={styles.main}>
        {filmsOnDate.length === 0 ? (
          <div className={styles.empty}>No showtimes for this date.</div>
        ) : (
          <div className={styles.filmList}>
            {filmsOnDate.map(({ film, showtimes, matches }) => (
              <FilmRow key={film.id ?? film.slug} film={film} showtimes={showtimes} venues={schedule.venues} viewMode={viewMode} fuseMatches={matches} />
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
    </div>
  );
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
}: {
  film: Film;
  showtimes: Showtime[];
  venues: Venue[];
  viewMode: ViewMode;
  fuseMatches: FuseResultMatch[];
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
          {film.year && <span className={styles.filmYearCompact}>{film.year}</span>}
          {film.director && <span className={styles.filmDirectorCompact}>dir. {highlightText(film.director, matches.director)}</span>}
          {film.runtime_minutes && <span className={styles.filmYearCompact}>{film.runtime_minutes}m</span>}
        </div>
        <div className={styles.showtimesCompact}>
          {[...byVenue.entries()].map(([venueId, times]) => (
            <span key={venueId} className={styles.venueBlockCompact}>
              <span className={styles.venueNameCompact}>
                {venueMap[venueId]?.name ?? venueId}
              </span>
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
                    {s.format && <span className={styles.format}> {s.format}</span>}
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
          className={styles.poster}
          src={posterUrl}
          alt={`${film.title} poster`}
          width={77}
          height={116}
          loading="lazy"
        />
      ) : (
        <div className={styles.posterPlaceholder} />
      )}

      <div className={styles.filmInfo}>
        <div className={styles.filmMeta}>
          <h2 className={styles.filmTitle}>{highlightText(film.title, matches.title)}</h2>
          <span className={styles.filmYear}>{film.year}</span>
          {film.director && (
            <span className={styles.filmDirector}>dir. {highlightText(film.director, matches.director)}</span>
          )}
          {film.runtime_minutes && (
            <span className={styles.filmRuntime}>{film.runtime_minutes}m</span>
          )}
        </div>

        {film.genres.length > 0 && (
          <div className={styles.genres}>
            {film.genres.map((g) => (
              <span key={g} className={styles.genre}>
                {highlightText(g, matches.genres.get(g) ?? [])}
              </span>
            ))}
          </div>
        )}

        <div className={styles.showtimesByVenue}>
          {[...byVenue.entries()].map(([venueId, times]) => (
            <div key={venueId} className={styles.venueShowtimes}>
              <span className={styles.venueName}>
                {venueMap[venueId]?.name ?? venueId}
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
                      {s.format && (
                        <span className={styles.format}> {s.format}</span>
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
