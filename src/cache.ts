import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Film } from "./types.js";

const CACHE_PATH = "data/enrichment-cache.json";

export type EnrichmentCache = Record<string, Film>; // keyed by venue title

export function loadCache(): EnrichmentCache {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveCache(cache: EnrichmentCache): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}
