import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Small Screens PDX",
  description: "Independent cinema showtimes across Portland",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
