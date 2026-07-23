// Single source of the app version, shared by the scraper (data provenance +
// User-Agent) and available to any Node-side code. The base semver lives in
// package.json; the short commit hash is derived at runtime so the full version
// reads "x.y.z-commithash" — identifying exactly which code produced a build/run.
//
// The frontend has its own copy of this composition in next.config.ts (it can't
// import from src/ across the build boundary), kept in the same "x.y.z-hash" shape.
import { readFileSync } from "fs";
import { execSync } from "child_process";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VERSION_BASE = pkg.version;

function shortCommit(): string {
  // CI exposes the SHA without a git checkout dir; fall back to git, then "dev".
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

export const COMMIT = shortCommit();
export const VERSION = `${VERSION_BASE}-${COMMIT}`;
export const USER_AGENT = `small-screens-pdx/${VERSION} (portland cinema aggregator)`;
