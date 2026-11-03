"use client";

import { useState } from "react";
import { bookOption, describeFailure } from "@/lib/api";
import { formatDuration, formatInr, formatInstant, plural } from "@/lib/format";
import type { BerthAssignment, Booking, ClassQuote, LegStatus, PlanOption } from "@/lib/types";

const STATUS_TEXT: Record<LegStatus, string> = {
  CONFIRMED: "Confirmed",
  BERTH_CHANGE: "Confirmed · berth change",
  TATKAL: "Tatkal confirmed",
  TATKAL_BERTH_CHANGE: "Tatkal · berth change",
  RAC: "RAC",
  WAITLIST: "Waitlist",
  CLOSED: "Closed",
};

export const isSeated = (s: LegStatus) => s === "CONFIRMED" || s === "BERTH_CHANGE" || s === "TATKAL" || s === "TATKAL_BERTH_CHANGE";

export function StatusChip({ status, rac, wl }: { status: LegStatus; rac?: number | null; wl?: number | null }) {
  const text = status === "RAC" && rac ? `RAC ${rac}` : status === "WAITLIST" && wl ? `WL ${wl}` : STATUS_TEXT[status];
  return <span className={`chip ${isSeated(status) ? "chip-ok" : status === "CLOSED" ? "chip-bad" : "chip-warn"}`}>{text}</span>;
}

export function Berths({ berths }: { berths: BerthAssignment[] }) {
  if (!berths.length) return null;
  return (
    <ul className="berths">
      {berths.map((b) => (
        <li key={b.passenger}>
          <span className="berth-pax">P{b.passenger}</span>
          {b.pieces.length === 1
            ? b.pieces[0]!.berth
            : b.pieces.map((p, i) => (
                <span key={i}>
                  {i > 0 && " → "}
                  {p.berth} <span className="berth-span">({p.from.code}–{p.to.code})</span>
                </span>
              ))}
        </li>
      ))}
    </ul>
  );
}

/** One planned option. `onBooked` lets the page refresh or link to the new booking. */
export function OptionCard({ option, onBooked, onUnauthorized, compact }: { option: PlanOption; onBooked?(b: Booking): void; onUnauthorized?(): void; compact?: boolean }) {
  const [state, setState] = useState<{ busy?: boolean; booking?: Booking; error?: string }>({});

  async function book() {
    setState({ busy: true });
    const outcome = await bookOption(option.id);
    if (outcome.kind === "ok") {
      setState({ booking: outcome.data.booking });
      onBooked?.(outcome.data.booking);
    } else {
      if (outcome.kind === "unauthorized") onUnauthorized?.();
      setState({ error: describeFailure(outcome) });
    }
  }

  const { journey } = option;
  return (
    <article className={`journey option${compact ? " compact" : ""}`}>
      <header className="journey-head option-head">
        <div>
          <h3>Option {option.rank}</h3>
          <p className="journey-times">
            {formatInstant(journey.departure)} → {formatInstant(journey.arrival)}
          </p>
          <p className="journey-meta">
            {formatDuration(journey.totalDurationMinutes)} · {journey.transferCount === 0 ? "Direct" : plural(journey.transferCount, "transfer")}
            {option.berthChanges > 0 && ` · ${plural(option.berthChanges, "berth change")}`}
          </p>
        </div>
        <div className="price">
          <strong>{formatInr(option.totalFare)}</strong>
          <span>
            {option.classCode} · {plural(option.passengers, "passenger")}
          </span>
        </div>
      </header>
      {option.tags.length > 0 && (
        <p className="tags">
          {option.tags.map((t) => (
            <span key={t} className={`tag${t === "Recommended" ? " tag-accent" : ""}`}>
              {t}
            </span>
          ))}
        </p>
      )}
      <ol className="legs">
        {option.legs.flatMap((leg, i) => {
          const transfer = journey.transfers[i];
          const items = [
            <li key={`leg-${i}`} className="leg">
              <div className="leg-top">
                <strong>
                  {leg.trainNumber} {leg.trainName}
                </strong>
                <StatusChip status={leg.status} rac={leg.racPosition} wl={leg.waitlistPosition} />
              </div>
              <div>
                {leg.from.name} · {formatInstant(leg.departure)}
              </div>
              <div>
                {leg.to.name} · {formatInstant(leg.arrival)}
              </div>
              <div className="journey-meta">
                {formatDuration(leg.durationMinutes)} · {Math.round(leg.distanceKm)} km · {formatInr(leg.fare)}
                {leg.quota === "TQ" && " · Tatkal quota"}
                {!isSeated(leg.status) && leg.status !== "CLOSED" && ` · ${Math.round(leg.confirmChance * 100)}% confirm chance`}
              </div>
              {leg.berthChangeStations.length > 0 && (
                <p className="leg-note">
                  Change berth (same train) at {leg.berthChangeStations.map((s) => s.name).join(", ")}
                  {leg.fare !== leg.singleTicketFare && ` · split tickets ${formatInr(leg.fare)} vs ${formatInr(leg.singleTicketFare)} single`}
                </p>
              )}
              {!compact && <Berths berths={leg.berths} />}
            </li>,
          ];
          if (transfer) {
            items.push(
              <li key={`transfer-${i}`} className="transfer">
                Change trains at {transfer.station.name} · wait {formatDuration(transfer.waitMinutes)}
              </li>,
            );
          }
          return items;
        })}
      </ol>
      <div className="journey-actions">
        {state.booking ? (
          <span className="action-note">
            Booked · PNR <strong>{state.booking.pnr}</strong> · {state.booking.status.replace("_", " ").toLowerCase()} ·{" "}
            <a href="/my-bookings">My bookings</a>
          </span>
        ) : (
          <>
            <button type="button" onClick={book} disabled={state.busy}>
              {state.busy ? "Booking…" : option.guaranteed ? "Book" : "Book (waitlist)"}
            </button>
            {state.error && <span className="action-note error">{state.error}</span>}
          </>
        )}
      </div>
    </article>
  );
}

export function ClassComparison({ quotes, current }: { quotes: ClassQuote[]; current: string }) {
  if (!quotes.length) return null;
  return (
    <section className="compare" aria-label="Price comparison by class for the top option">
      <h2 className="compare-title">Same trains, other classes</h2>
      <div className="compare-grid">
        {quotes.map((q) => (
          <div key={q.classCode} className={`compare-cell${q.classCode === current ? " is-current" : ""}`}>
            <span className="compare-class">{q.classCode}</span>
            <strong>{formatInr(q.fare)}</strong>
            <StatusChip status={q.status} />
          </div>
        ))}
      </div>
    </section>
  );
}
