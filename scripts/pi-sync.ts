// Keeps pi-scraper/'s copies of shared modules identical to src/.
//
// pi-scraper/ is copied to the residential host by hand and has to be
// self-contained, so it carries its own copies of a few src/ files. This script
// is the one way they get updated:
//
//   npm run pi:sync    copy src/ → pi-scraper/src/ for every shared file
//   npm run pi:check   exit 1 if any copy differs (runs on pre-push)
//
// Line endings are ignored when comparing, so a Windows checkout doesn't trip it.
// Files that exist only in pi-scraper (hollywood.ts, code-hash.ts) aren't listed.
import { existsSync, readFileSync, writeFileSync } from "fs";

const SHARED = [
  "types.ts",
  "fetch.ts",
  "browser.ts",
  "version.ts",
  "window.ts",
  "scrapers/omsi.ts",
];

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const check = process.argv.includes("--check");

const drifted = SHARED.filter((f) => {
  const dest = `pi-scraper/src/${f}`;
  return !existsSync(dest) || norm(readFileSync(`src/${f}`, "utf8")) !== norm(readFileSync(dest, "utf8"));
});

if (drifted.length === 0) {
  console.log(`pi-scraper: all ${SHARED.length} shared files match src/`);
} else if (check) {
  console.error(`pi-scraper copies out of date: ${drifted.join(", ")}`);
  console.error("Run `npm run pi:sync`, commit, then copy pi-scraper/ to the host.");
  process.exit(1);
} else {
  for (const f of drifted) writeFileSync(`pi-scraper/src/${f}`, readFileSync(`src/${f}`));
  console.log(`pi-scraper: updated ${drifted.join(", ")}. Copy pi-scraper/ to the host.`);
}
