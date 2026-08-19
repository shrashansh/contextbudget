import type { Metadata } from "next";
import { Oswald, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font — no runtime request to Google, which
// keeps the CSP tight and avoids a third-party dependency on the deployed page.
const display = Oswald({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

// Symbol ids, token counts and diffs are technical values and stay monospace —
// the spec lists JetBrains Mono for exactly this. A condensed display face makes
// `APIRouter.add_api_route` unreadable, and that is most of the screen.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ContextBudget — what to feed the model, and what it costs",
  description:
    "Pick a repo and a task, set a token budget, and see exactly which symbols make the pack, which are left out, and what the pack would cost across models.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
