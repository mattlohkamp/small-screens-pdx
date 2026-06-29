import type { NextConfig } from "next";
import { execSync } from "node:child_process";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Stamp the build with its source version so the deployed UI is identifiable
// from the live site (see <head> meta tags in app/layout.tsx). CI passes an
// explicit version; local builds fall back to the current git short SHA.
function resolveBuildVersion(): string {
  if (process.env.NEXT_PUBLIC_BUILD_VERSION) return process.env.NEXT_PUBLIC_BUILD_VERSION;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

const buildVersion = resolveBuildVersion();
const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME ?? new Date().toISOString();

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  basePath,
  assetPrefix: basePath,
  env: {
    NEXT_PUBLIC_BUILD_VERSION: buildVersion,
    NEXT_PUBLIC_BUILD_TIME: buildTime,
  },
};

export default nextConfig;
