"use client";

import { useEffect, useRef, useState } from "react";
import { AuthPrompt } from "@/components/AuthPrompt";
import { ClassComparison, OptionCard } from "@/components/OptionCard";
import { StationField } from "@/components/StationField";
import { autoBook, describeFailure, fetchPlan, type AutoBookResult, type PlanQuery } from "@/lib/api";
import { addDaysIso, formatInr, localToday } from "@/lib/format";
import { apiStationSource } from "@/lib/stationSource";
import { CLASS_OPTIONS, type ClassCode, type PlanResult, type Preference, type Station } from "@/lib/types";

type Side = { text: string; station: Station | null };
const EMPTY: Side = { text: "", station: null };

const PREFERENCES: { value: Preference; label: string }[] = [
  { value: "balanced", label: "Balanced" },
  { value: "confirmed", label: "Surest seat" },
  { value: "cheapest", label: "Cheapest" },
  { value: "fastest", label: "Fastest" },
];

const BERTHS = [
  { value: "", label: "No preference" },
  { value: "LB", label: "Lower" },
  { value: "MB", label: "Middle" },
  { value: "UB", label: "Upper" },
  { value: "SL", label: "Side lower" },
  { value: "SU", label: "Side upper" },
  { value: "WS", label: "Window seat (CC)" },
];

export function BookPage() {
  const [from, setFrom] = useState<Side>(EMPTY);
  const [to, setTo] = useState<Side>(EMPTY);
  const [date, setDate] = useState("");
  const [today, setToday] = useState("");
  const [classCode, setClassCode] = useState<ClassCode>("3A");
  const [passengers, setPassengers] = useState("1");
  const [preference, setPreference] = useState<Preference>("balanced");
  const [berth, setBerth] = useState("");
  const [flexible, setFlexible] = useState("0");
  const [maxFare, setMaxFare] = useState("");
  const [busy, setBusy] = useState<"" | "plan" | "auto">("");
  const [status, setStatus] = useState<{ message: string; error?: boolean }>({ message: "" });
  const [result, setResult] = useState<PlanResult | null>(null);
  const [auto, setAuto] = useState<AutoBookResult | null>(null);
  const [needAuth, setNeedAuth] = useState(false);
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = localToday();
    setToday(t);
    setDate(addDaysIso(t, 14));
  }, []);

  function query(): PlanQuery | null {
    if (!from.station) {
      fromInput.current?.focus();
      setStatus({ message: "Pick a source station from the suggestions.", error: true });
      return null;
    }
    if (!to.station || to.station.id === from.station.id) {
      toInput.current?.focus();
      setStatus({ message: "Pick a different destination station from the suggestions.", error: true });
      return null;
    }
    if (!date || date < today) {
      setStatus({ message: "Choose a travel date that is today or later.", error: true });
      return null;
    }
    return {
      from: from.station.code ?? from.station.id,
      to: to.station.code ?? to.station.id,
      date,
      class: classCode,
      passengers: Number(passengers),
      preference,
      ...(berth && { berth }),
      ...(flexible !== "0" && { flexibleDays: Number(flexible) }),
    };
  }

  async function plan() {
    const q = query();
    if (!q) return;
    setBusy("plan");
    setNeedAuth(false);
    setAuto(null);
    setStatus({ message: "Searching every route, berth and combination…" });
    const outcome = await fetchPlan(q);
    setBusy("");
    if (outcome.kind !== "ok") {
      setResult(null);
      if (outcome.kind === "unauthorized") setNeedAuth(true);
      return setStatus({ message: describeFailure(outcome), error: true });
    }
    setResult(outcome.data);
    const n = outcome.data.options.length;
    const sure = outcome.data.options.filter((o) => o.guaranteed).length;
    setStatus({ message: n ? `${n} option${n === 1 ? "" : "s"} · ${sure} with confirmed berths on every leg` : outcome.data.notes.join(" ") });
  }

  async function runAuto() {
    const q = query();
    if (!q) return;
    setBusy("auto");
    setNeedAuth(false);
    setStatus({ message: "Finding and booking the best confirmed option…" });
    const outcome = await autoBook({ ...q, ...(Number(maxFare) > 0 && { maxFare: Number(maxFare) }), requireConfirmed: true });
    setBusy("");
    if (outcome.kind !== "ok") {
      if (outcome.kind === "unauthorized") setNeedAuth(true);
      return setStatus({ message: describeFailure(outcome), error: true });
    }
    setAuto(outcome.data);
    setStatus({ message: outcome.data.message, error: !outcome.data.booking });
  }

  return (
    <>
      <h1>Book a seat that&apos;s actually confirmed</h1>
      <p className="lede">
        Reroute checks every direct train, connection and berth-change combination, then ranks what you can book now, cheapest to surest.
      </p>

      <form
        className="cad"
        autoComplete="off"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void plan();
        }}
      >
        <div className="route">
          <StationField
            label="From"
            source={apiStationSource}
            text={from.text}
            station={from.station}
            inputRef={fromInput}
            onText={(text) => setFrom({ text, station: null })}
            onSelect={(station) => setFrom({ text: station.name, station })}
            disabledReason={(s) => (to.station?.id === s.id ? "Already chosen as destination" : null)}
          />
          <button type="button" className="swap" onClick={() => (setFrom(to), setTo(from))} aria-label="Swap source and destination">
            ⇄
          </button>
          <StationField
            label="To"
            source={apiStationSource}
            text={to.text}
            station={to.station}
            inputRef={toInput}
            onText={(text) => setTo({ text, station: null })}
            onSelect={(station) => setTo({ text: station.name, station })}
            disabledReason={(s) => (from.station?.id === s.id ? "Already chosen as origin" : null)}
          />
        </div>
        <div>
          <label htmlFor="b-date">Date</label>
          <input id="b-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="b-flex">Flexible dates</label>
          <select id="b-flex" value={flexible} onChange={(e) => setFlexible(e.target.value)}>
            <option value="0">Exact date</option>
            <option value="1">± 1 day</option>
            <option value="2">± 2 days</option>
          </select>
        </div>
        <div>
          <label htmlFor="b-class">Class</label>
          <select id="b-class" value={classCode} onChange={(e) => setClassCode(e.target.value as ClassCode)}>
            {CLASS_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="b-pax">Passengers</label>
          <select id="b-pax" value={passengers} onChange={(e) => setPassengers(e.target.value)}>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="b-pref">Rank by</label>
          <select id="b-pref" value={preference} onChange={(e) => setPreference(e.target.value as Preference)}>
            {PREFERENCES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="b-berth">Berth preference</label>
          <select id="b-berth" value={berth} onChange={(e) => setBerth(e.target.value)}>
            {BERTHS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <div className="full form-actions">
          <button type="submit" disabled={!!busy}>
            {busy === "plan" ? "Searching…" : "Find seats"}
          </button>
          <span className="auto-book">
            <label htmlFor="b-max" className="visually-hidden">
              Fare limit
            </label>
            <input id="b-max" type="number" min={0} step={50} placeholder="Max fare ₹ (optional)" value={maxFare} onChange={(e) => setMaxFare(e.target.value)} />
            <button type="button" className="secondary" disabled={!!busy} onClick={() => void runAuto()}>
              {busy === "auto" ? "Booking…" : "Auto-book best confirmed"}
            </button>
          </span>
        </div>
      </form>

      <p id="status" role="status" aria-live="polite" className={status.error ? "error" : ""}>
        {status.message}
      </p>
      {needAuth && <AuthPrompt next="/book" />}

      {auto && (
        <section className="journey auto-result">
          <h3 className="journey-head">Auto-booking</h3>
          {auto.booking && (
            <p>
              PNR <strong>{auto.booking.pnr}</strong> · {formatInr(auto.booking.totalFare)} · <a href="/my-bookings">view in My bookings</a>
            </p>
          )}
          <ol className="attempts">
            {auto.attempts.map((a, i) => (
              <li key={i}>
                <span className="journey-meta">{a.outcome}</span>
                <br />
                {a.option}
              </li>
            ))}
          </ol>
        </section>
      )}

      {result && (
        <div aria-busy={busy === "plan" || undefined} id="results">
          <ClassComparison quotes={result.classComparison} current={classCode} />
          {result.options.map((o) => (
            <OptionCard key={o.id} option={o} onUnauthorized={() => setNeedAuth(true)} />
          ))}
          {result.notes.length > 0 && (
            <ul className="search-warnings">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
