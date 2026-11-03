"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Berths, StatusChip } from "@/components/OptionCard";
import { cancelBooking, describeFailure, fetchRefundQuote, listBookings } from "@/lib/api";
import { formatInr, formatInstant, formatSavedAt, plural } from "@/lib/format";
import type { Booking, RefundQuote } from "@/lib/types";

const STATUS_LABEL: Record<Booking["status"], string> = {
  CONFIRMED: "Confirmed",
  PARTIALLY_CONFIRMED: "Partly confirmed",
  WAITLISTED: "Waitlisted",
  CANCELLED: "Cancelled",
};

function BookingCard({ booking, onChanged, onUnauthorized }: { booking: Booking; onChanged(): void; onUnauthorized(): void }) {
  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function askQuote() {
    setBusy(true);
    setError("");
    const outcome = await fetchRefundQuote(booking.pnr);
    setBusy(false);
    if (outcome.kind === "ok") setQuote(outcome.data);
    else {
      if (outcome.kind === "unauthorized") onUnauthorized();
      setError(describeFailure(outcome));
    }
  }

  async function confirmCancel() {
    setBusy(true);
    const outcome = await cancelBooking(booking.pnr);
    setBusy(false);
    if (outcome.kind === "ok") {
      setQuote(null);
      onChanged();
    } else setError(describeFailure(outcome));
  }

  const cancelled = booking.status === "CANCELLED";
  return (
    <article className={`journey booking${cancelled ? " is-cancelled" : ""}`}>
      <header className="journey-head option-head">
        <div>
          <h3>
            PNR {booking.pnr} · {STATUS_LABEL[booking.status]}
          </h3>
          <p className="journey-times">
            {booking.source.name} → {booking.destination.name}
          </p>
          <p className="journey-meta">
            {formatInstant(booking.departure)} → {formatInstant(booking.arrival)} · {booking.classCode} · {plural(booking.passengers, "passenger")}
          </p>
        </div>
        <div className="price">
          <strong>{formatInr(booking.totalFare)}</strong>
          <span>booked {formatSavedAt(booking.createdAt)}</span>
        </div>
      </header>
      <ol className="legs">
        {booking.legs.map((leg, i) => (
          <li key={i} className="leg">
            <div className="leg-top">
              <strong>
                {leg.trainNumber} {leg.trainName}
              </strong>
              <StatusChip status={leg.status} rac={leg.racPosition} wl={leg.waitlistPosition} />
            </div>
            <div>
              {leg.from.name} · {formatInstant(leg.departure)} → {leg.to.name} · {formatInstant(leg.arrival)}
            </div>
            {leg.berthChangeStations.length > 0 && <p className="leg-note">Change berth (same train) at {leg.berthChangeStations.map((s) => s.name).join(", ")}</p>}
            <Berths berths={leg.berths} />
          </li>
        ))}
      </ol>
      {booking.refund && (
        <p className="action-note">
          Refunded {formatInr(booking.refund.amount)} ({booking.refund.daysBefore} day{booking.refund.daysBefore === 1 ? "" : "s"} before departure · {booking.refund.rule})
        </p>
      )}
      <details className="history">
        <summary>History</summary>
        <ul>
          {booking.history.map((h, i) => (
            <li key={i}>
              <span className="journey-meta">{formatInstant(h.at)}</span> {h.message}
            </li>
          ))}
        </ul>
      </details>
      {!cancelled && (
        <div className="journey-actions">
          {quote ? (
            <>
              <span className="action-note">
                Cancelling now refunds <strong>{formatInr(quote.amount)}</strong> ({Math.round(quote.ratio * 100)}% · {quote.daysBefore} days before)
              </span>
              <button type="button" className="danger" disabled={busy} onClick={() => void confirmCancel()}>
                Confirm cancellation
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setQuote(null)}>
                Keep booking
              </button>
            </>
          ) : (
            <button type="button" className="secondary" disabled={busy} onClick={() => void askQuote()}>
              Cancel…
            </button>
          )}
          {error && <span className="action-note error">{error}</span>}
        </div>
      )}
    </article>
  );
}

export function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [status, setStatus] = useState("");
  const [needAuth, setNeedAuth] = useState(false);

  const load = useCallback(async () => {
    const outcome = await listBookings();
    if (outcome.kind === "ok") {
      setBookings(outcome.data.bookings);
      setStatus("");
    } else {
      if (outcome.kind === "unauthorized") setNeedAuth(true);
      setStatus(describeFailure(outcome));
    }
  }, []);

  useEffect(() => {
    void load();
    // The assistant can book or cancel too; refresh when it does.
    const onChange = () => void load();
    window.addEventListener("reroute:bookings-changed", onChange);
    return () => window.removeEventListener("reroute:bookings-changed", onChange);
  }, [load]);

  return (
    <>
      <h1>My bookings</h1>
      <p className="lede">Tickets you booked here or through the assistant. Cancelling frees the berths, which can confirm waitlisted passengers.</p>
      {needAuth && <AuthPrompt next="/my-bookings" />}
      {status && <p id="status">{status}</p>}
      {bookings?.length === 0 && (
        <p className="empty">
          No bookings yet. <a href="/book">Find a confirmed seat</a>.
        </p>
      )}
      {bookings?.map((b) => (
        <BookingCard key={b.pnr} booking={b} onChanged={() => void load()} onUnauthorized={() => setNeedAuth(true)} />
      ))}
    </>
  );
}
