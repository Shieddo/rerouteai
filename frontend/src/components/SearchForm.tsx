"use client";

import { useEffect, useRef, useState } from "react";
import { StationField } from "@/components/StationField";
import { localNow, localToday } from "@/lib/format";
import { apiStationSource } from "@/lib/stationSource";
import type { Station } from "@/lib/types";

export const MAX_TRANSFERS_LIMIT = 4;

export type SearchMode = "alternatives" | "direct";

export type SearchValues = {
  /** Station codes (or ids when a station has no code), never the typed text. */
  from: string;
  to: string;
  date: string;
  /** Earliest departure, HH:MM. Only present in alternatives mode. */
  time?: string;
  maxTransfers?: number;
};

type Props = {
  mode: SearchMode;
  onModeChange(mode: SearchMode): void;
  busy: boolean;
  onSubmit(values: SearchValues): void | Promise<void>;
};

type Side = { text: string; station: Station | null };
const EMPTY: Side = { text: "", station: null };
const identifier = (station: Station) => station.code ?? station.id;

export function SearchForm({ mode, onModeChange, busy, onSubmit }: Props) {
  const [from, setFrom] = useState<Side>(EMPTY);
  const [to, setTo] = useState<Side>(EMPTY);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [maxTransfers, setMaxTransfers] = useState("2");
  const [errors, setErrors] = useState<Partial<Record<"from" | "to" | "date" | "time" | "transfers", string>>>({});
  const [today, setToday] = useState("");
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const transfersInput = useRef<HTMLInputElement>(null);

  // Defaults come from the browser's clock, so they are set after mount to keep server and client markup identical.
  useEffect(() => {
    const t = localToday();
    setToday(t);
    setDate(t);
    setTime(localNow());
  }, []);

  const alternatives = mode === "alternatives";

  function swap() {
    setFrom(to);
    setTo(from);
    setErrors((e) => ({ ...e, from: undefined, to: undefined }));
  }

  function validate(): boolean {
    const next: typeof errors = {};
    const focus: HTMLInputElement[] = [];
    const bad = (key: keyof typeof next, message: string, input: HTMLInputElement | null) => {
      next[key] = message;
      if (input) focus.push(input);
    };

    if (!from.station) bad("from", "Select a source station from the suggestions.", fromInput.current);
    if (!to.station) bad("to", "Select a destination station from the suggestions.", toInput.current);
    else if (from.station && from.station.id === to.station.id) bad("to", "Source and destination must be different.", toInput.current);
    if (date === "" || date < today) bad("date", "Choose a travel date that is today or later.", dateInput.current);
    if (alternatives) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) bad("time", "Enter the earliest departure time.", timeInput.current);
      if (!/^\d+$/.test(maxTransfers) || Number(maxTransfers) > MAX_TRANSFERS_LIMIT) {
        bad("transfers", `Maximum transfers must be between 0 and ${MAX_TRANSFERS_LIMIT}.`, transfersInput.current);
      }
    }
    setErrors(next);
    focus[0]?.focus();
    return focus.length === 0;
  }

  return (
    <form
      id="search-form"
      className="cad"
      autoComplete="off"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!validate()) return;
        void onSubmit({
          from: identifier(from.station!),
          to: identifier(to.station!),
          date,
          ...(alternatives && { time, maxTransfers: Number(maxTransfers) }),
        });
      }}
    >
      <div className="route">
        <StationField
          label="From"
          source={apiStationSource}
          text={from.text}
          station={from.station}
          inputRef={fromInput}
          error={errors.from}
          onText={(text) => {
            setFrom({ text, station: null });
            setErrors((e) => ({ ...e, from: undefined }));
          }}
          onSelect={(station) => {
            setFrom({ text: station.name, station });
            setErrors((e) => ({ ...e, from: undefined, to: e.to?.startsWith("Source and") ? undefined : e.to }));
          }}
          disabledReason={(s) => (to.station?.id === s.id ? "Already chosen as destination" : null)}
        />
        <button type="button" className="swap" onClick={swap} aria-label="Swap source and destination">
          ⇄
        </button>
        <StationField
          label="To"
          source={apiStationSource}
          text={to.text}
          station={to.station}
          inputRef={toInput}
          error={errors.to}
          onText={(text) => {
            setTo({ text, station: null });
            setErrors((e) => ({ ...e, to: undefined }));
          }}
          onSelect={(station) => {
            setTo({ text: station.name, station });
            setErrors((e) => ({ ...e, to: undefined }));
          }}
          disabledReason={(s) => (from.station?.id === s.id ? "Already chosen as origin" : null)}
        />
      </div>

      <fieldset className="mode">
        <legend className="visually-hidden">Search type</legend>
        <label>
          <input type="radio" name="mode" value="alternatives" checked={alternatives} onChange={() => onModeChange("alternatives")} /> Alternative journeys
        </label>
        <label>
          <input type="radio" name="mode" value="direct" checked={!alternatives} onChange={() => onModeChange("direct")} /> Direct trains
        </label>
      </fieldset>

      <div>
        <label htmlFor="date">Date</label>
        <input
          ref={dateInput}
          id="date"
          type="date"
          required
          min={today}
          value={date}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby="date-error"
          onChange={(e) => {
            setDate(e.target.value);
            setErrors((x) => ({ ...x, date: undefined }));
          }}
        />
        <p className="field-error" id="date-error" role="alert" hidden={!errors.date}>
          {errors.date}
        </p>
      </div>

      {alternatives && (
        <>
          <div>
            <label htmlFor="time">Earliest departure</label>
            <input
              ref={timeInput}
              id="time"
              type="time"
              required
              value={time}
              aria-invalid={errors.time ? true : undefined}
              aria-describedby="time-error"
              onChange={(e) => {
                setTime(e.target.value);
                setErrors((x) => ({ ...x, time: undefined }));
              }}
            />
            <p className="field-error" id="time-error" role="alert" hidden={!errors.time}>
              {errors.time}
            </p>
          </div>
          <div>
            <label htmlFor="maxTransfers">Maximum transfers</label>
            <input
              ref={transfersInput}
              id="maxTransfers"
              type="number"
              min={0}
              max={MAX_TRANSFERS_LIMIT}
              step={1}
              value={maxTransfers}
              aria-invalid={errors.transfers ? true : undefined}
              aria-describedby="transfers-error"
              onChange={(e) => {
                setMaxTransfers(e.target.value);
                setErrors((x) => ({ ...x, transfers: undefined }));
              }}
            />
            <p className="field-error" id="transfers-error" role="alert" hidden={!errors.transfers}>
              {errors.transfers}
            </p>
          </div>
        </>
      )}

      <div style={{ alignSelf: "end" }}>
        <button id="submit" type="submit" disabled={busy}>
          {alternatives ? "Find journeys" : "Search trains"}
        </button>
      </div>
    </form>
  );
}
