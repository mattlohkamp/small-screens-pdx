import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Small Screens PDX",
  description: "Independent cinema showtimes across Portland",
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
