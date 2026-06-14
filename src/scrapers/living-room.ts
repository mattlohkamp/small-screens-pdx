import type { Film, Showtime } from "../types.js";
import { getBrowser } from "../browser.js";

const VENUE_ID = "living-room";
const MOVIES_URL = "https://pdx.livingroomtheaters.com/movies";
const GQL = "https://pdx.livingroomtheaters.com/graphql";
const CIRCUIT_ID = "146";
const SITE_ID = 317;
const TICKET_BASE = "https://pdx.livingroomtheaters.com/purchase";

interface LRMovie {
  id: string;
  name: string;
  duration: number | null; // minutes
  directedBy: string | null;
  urlSlug: string;
  datesWithPublicShowing: string[];
}

interface LRShowing {
  id: string;
  time: string; // UTC ISO
  movie: { id: string; urlSlug: string };
}

// UTC ISO → local Pacific datetime string
function utcToLocalPacific(utc: string): string {
  const d = new Date(utc);
  return d.toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const MOVIES_QUERY = `query ($limit: Int, $orderBy: String, $descending: Boolean, $searchString: String, $siteIds: [ID], $type: String) {
  movies(limit: $limit orderBy: $orderBy descending: $descending searchString: $searchString siteIds: $siteIds type: $type) {
    data { id name duration directedBy urlSlug datesWithPublicShowing __typename }
    count __typename
  }
}`;

const SHOWINGS_FOR_DATE_QUERY = `query ($date: String, $ids: [ID], $movieId: ID, $movieIds: [ID], $titleClassId: ID, $titleClassIds: [ID], $siteIds: [ID], $everyShowingBadgeIds: [ID], $anyShowingBadgeIds: [ID], $resultVersion: String) {
  showingsForDate(date: $date ids: $ids movieId: $movieId movieIds: $movieIds titleClassId: $titleClassId titleClassIds: $titleClassIds siteIds: $siteIds everyShowingBadgeIds: $everyShowingBadgeIds anyShowingBadgeIds: $anyShowingBadgeIds resultVersion: $resultVersion) {
    data { id time movie { id urlSlug __typename } __typename }
    count __typename
  }
}`;

export async function scrapeLivingRoom(): Promise<Film[]> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  try {
    // Load the movies page and wait for the now-playing GQL response
    const moviesResponsePromise = page.waitForResponse(
      res => res.url() === GQL && (res.request().postData() ?? "").includes('"now-playing"'),
      { timeout: 20000 }
    );
    await page.goto(MOVIES_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Also wait for addOrUpdateClientConfig so site-id/circuit-id headers are set
    const sessionReadyPromise = page.waitForResponse(
      res => res.url() === GQL && (res.request().postData() ?? "").includes("addOrUpdateClientConfig"),
      { timeout: 20000 }
    );
    await sessionReadyPromise;

    const moviesResponse = await moviesResponsePromise;
    const moviesJson = await moviesResponse.json() as { data?: { movies?: { data: LRMovie[] } } };
    const moviesData = moviesJson?.data?.movies?.data ?? [];

    if (!moviesData.length) {
      console.log("  No movies currently scheduled at Living Room Theaters");
      return [];
    }
    console.log(`  Found ${moviesData.length} movies`);

    // Build the set of upcoming dates that have showings (from datesWithPublicShowing)
    const start = today();
    const end = addDays(start, 14);
    const datesWithShowings = new Set(
      moviesData.flatMap(m => m.datesWithPublicShowing ?? [])
        .filter(d => d >= start && d <= end)
    );
    const datesToFetch = [...datesWithShowings].sort();
    console.log(`  Fetching showings for ${datesToFetch.length} dates in parallel...`);

    const movieIds = moviesData.map(m => m.id);

    // Query showingsForDate for each date using the correct auth headers
    const dateResults = await Promise.all(
      datesToFetch.map(date =>
        page.evaluate(
          async ({ gql, query, date, movieIds, siteId, circuitId }: {
            gql: string; query: string; date: string;
            movieIds: string[]; siteId: number; circuitId: string;
          }) => {
            const r = await fetch(gql, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "accept": "application/graphql-response+json,application/json;q=0.9",
                "site-id": String(siteId),
                "circuit-id": circuitId,
                "client-type": "consumer",
                "is-electron-mode": "false",
              },
              body: JSON.stringify({
                variables: { date, siteIds: [siteId], ids: [], movieId: null, movieIds, titleClassId: null, titleClassIds: [], everyShowingBadgeIds: [null], anyShowingBadgeIds: null, resultVersion: null },
                extensions: { clientLibrary: { name: "@apollo/client", version: "4.0.9" } },
                query,
              }),
            });
            return r.json();
          },
          { gql: GQL, query: SHOWINGS_FOR_DATE_QUERY, date, movieIds, siteId: SITE_ID, circuitId: CIRCUIT_ID }
        ) as Promise<{ data?: { showingsForDate?: { data: LRShowing[] } }; errors?: Array<{ message: string }> }>
      )
    );

    const showingsByMovie = new Map<string, LRShowing[]>();
    for (const res of dateResults) {
      if (res.errors) { console.warn("  GQL error:", res.errors[0]?.message); continue; }
      for (const s of res?.data?.showingsForDate?.data ?? []) {
        const key = s.movie?.id;
        if (!key) continue;
        const list = showingsByMovie.get(key) ?? [];
        list.push(s);
        showingsByMovie.set(key, list);
      }
    }

    const totalShowings = [...showingsByMovie.values()].flat().length;
    console.log(`  ${totalShowings} showings across ${showingsByMovie.size} movies`);

    return moviesData.map(movie => {
      const movieShowings = showingsByMovie.get(movie.id) ?? [];
      const showtimes: Showtime[] = movieShowings.map(s => ({
        venue_id: VENUE_ID,
        datetime: utcToLocalPacific(s.time),
        format: null,
        ticket_url: `${TICKET_BASE}/${s.movie?.urlSlug ?? movie.urlSlug}?showingId=${s.id}`,
      }));

      return {
        id: null,
        slug: movie.urlSlug || movie.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        title: movie.name,
        year: null,
        director: movie.directedBy ?? null,
        runtime_minutes: movie.duration ?? null,
        overview: null,
        poster_path: null,
        genres: [],
        showtimes,
      } satisfies Film;
    }).filter(f => f.showtimes.length > 0);
  } finally {
    await ctx.close();
  }
}

// Run directly: tsx src/scrapers/living-room.ts
if (process.argv[1].includes("living-room")) {
  const films = await scrapeLivingRoom();
  console.log(JSON.stringify(films, null, 2));
}
