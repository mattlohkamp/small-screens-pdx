import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Small Screens PDX",
  description: "Independent cinema showtimes across Portland",
  // Lets feed readers discover the RSS feed from the site URL.
  alternates: {
    types: {
      "application/rss+xml": [
        { url: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/feeds/new.xml`, title: "Small Screens PDX: newly showing" },
      ],
    },
  },
  // Build provenance — inspect on the live site to see which commit/release is deployed.
  other: {
    "build-version": process.env.NEXT_PUBLIC_BUILD_VERSION ?? "dev",
    "build-time": process.env.NEXT_PUBLIC_BUILD_TIME ?? "",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
