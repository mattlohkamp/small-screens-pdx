// Fingerprint of the pi-scraper code. The host stamps it into every raw file it
// pushes; CI computes the same hash over pi-scraper/ in its checkout and alerts
// on a mismatch. Code reaches the host by hand (scp), so without this the host
// could silently keep running stale scrapers after an update here.
//
// Imported by both run.ts (on the host) and src/pi-source.ts (in CI), so the
// two sides can never disagree about what gets hashed. Node built-ins only.
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";

// Everything that decides what the host runs: entry point, scraper sources, and
// the pinned dependency set. Host-only files (cron script, node_modules) and the
// repo's own extras are deliberately outside this list.
const TOP_LEVEL = ["run.ts", "package.json", "package-lock.json"];

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFilesUnder(p);
    return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
  });
}

export function piCodeHash(root: string): string {
  const files = [
    ...TOP_LEVEL.map((f) => join(root, f)).filter((f) => existsSync(f)),
    ...tsFilesUnder(join(root, "src")),
  ]
    .map((abs) => ({ abs, rel: relative(root, abs).split(sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  for (const { abs, rel } of files) {
    // Normalize line endings so a Windows checkout and the Linux host agree.
    const text = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    hash.update(`${rel}\0${text}\0`);
  }
  return hash.digest("hex").slice(0, 12);
}
