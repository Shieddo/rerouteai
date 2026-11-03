import type { Metadata } from "next";
import { Aleo, Azeret_Mono, Host_Grotesk } from "next/font/google";
import { ChatWidget } from "@/components/ChatWidget";
import { Header } from "@/components/Header";
import "./globals.css";

const aleo = Aleo({ subsets: ["latin"], variable: "--font-aleo", display: "swap" });
const hostGrotesk = Host_Grotesk({ subsets: ["latin"], variable: "--font-host-grotesk", display: "swap" });
const azeretMono = Azeret_Mono({ subsets: ["latin"], variable: "--font-azeret-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Reroute · Confirmed train tickets",
  description: "Find, compare and book confirmed train seats across India, with an AI assistant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${aleo.variable} ${hostGrotesk.variable} ${azeretMono.variable}`}>
      <body>
        <main>
          <Header />
          {children}
        </main>
        <ChatWidget />
      </body>
    </html>
  );
}
