import type { Metadata } from "next";
import { Aleo, Azeret_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";

const aleo = Aleo({ subsets: ["latin"], variable: "--font-aleo", display: "swap" });
const hostGrotesk = Host_Grotesk({ subsets: ["latin"], variable: "--font-host-grotesk", display: "swap" });
const azeretMono = Azeret_Mono({ subsets: ["latin"], variable: "--font-azeret-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Reroute · Confirmed train tickets", template: "%s · Reroute" },
  description: "Find, compare and book confirmed train seats across India, with an AI assistant.",
};

// Only the document shell lives here. Each route group — (marketing), (auth), (app) — brings its own
// chrome through its layout.tsx, so new sections can pick a shell without touching the others.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${aleo.variable} ${hostGrotesk.variable} ${azeretMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
