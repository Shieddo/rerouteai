"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { APP_NAV, ROUTES } from "@/config/routes";
import { AuthPrompt } from "@/components/AuthPrompt";
import { fetchProfile, listBookings, listSavedJourneys, type Profile } from "@/lib/api";
import { formatInr, formatInstant, plural } from "@/lib/format";
import type { Booking, SavedJourney } from "@/lib/types";

type State = { loading: true } | { loading: false; profile: Profile | null; bookings: Booking[]; saved: SavedJourney[] };

export function HomePage() {
  const [state, setState] = useState<State>({ loading: true });

  useEffect(() => {
    let current = true;
    (async () => {
      const profile = await fetchProfile();
      if (!profile) return current && setState({ loading: false, profile: null, bookings: [], saved: [] });
      const [b, s] = await Promise.all([listBookings(), listSavedJourneys()]);
      if (current)
        setState({ loading: false, profile, bookings: b.kind === "ok" ? b.data.bookings : [], saved: s.kind === "ok" ? s.journeys : [] });
    })();
    return () => {
      current = false;
    };
  }, []);

  if (state.loading) return <p className="empty">Loading your home…</p>;
  if (!state.profile) {
    return (
      <>
        <h1>Welcome to Reroute</h1>
        <p className="lede">Sign in to see your trips and shortcuts.</p>
        <AuthPrompt next={ROUTES.home.href} />
      </>
    );
  }

  const { profile, bookings, saved } = state;
  const upcoming = bookings.filter((b) => b.status !== "CANCELLED").slice(0, 3);
  const shortcuts = APP_NAV.filter((r) => r.href !== ROUTES.home.href);

  return (
    <>
      <h1>Hi, {profile.name ?? profile.email ?? "traveller"}</h1>
      <p className="lede">
        {bookings.length === 0 ? "You have no bookings yet." : `${plural(upcoming.length, "active booking")}`} · {plural(saved.length, "saved journey")}
      </p>

      <div className="home-grid">
        {shortcuts.map((r) => (
          <Link key={r.href} href={r.href} className="home-tile cad">
            <strong>{r.label}</strong>
            <span>{r.description}</span>
          </Link>
        ))}
      </div>

      <h2 className="view-title home-section">Recent bookings</h2>
      {upcoming.length === 0 ? (
        <p className="empty">
          Nothing booked yet. <Link href={ROUTES.book.href}>Find a train →</Link>
        </p>
      ) : (
        upcoming.map((b) => (
          <article key={b.pnr} className="journey">
            <header className="journey-head option-head">
              <div>
                <h3>PNR {b.pnr}</h3>
                <p className="journey-times">
                  {b.source.name} → {b.destination.name}
                </p>
                <p className="journey-meta">
                  {formatInstant(b.departure)} · {plural(b.passengers, "passenger")} · {b.classCode}
                </p>
              </div>
              <div className="price">
                <strong>{formatInr(b.totalFare)}</strong>
                <span>{b.status.replace("_", " ").toLowerCase()}</span>
              </div>
            </header>
          </article>
        ))
      )}
      {bookings.length > 0 && (
        <p>
          <Link href={ROUTES.bookings.href}>See all bookings →</Link>
        </p>
      )}
    </>
  );
}
