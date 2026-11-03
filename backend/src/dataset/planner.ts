// Seat-guaranteeing trip planner. Searches every train combination (direct and with transfers),
// then, for each leg, looks for: a single berth; failing that, a chain of berths on the same
// train ("intermediate berth" / berth change at a station on the way); failing that, Tatkal when
// it is open; and otherwise reports the RAC/waitlist position and confirmation chance. Options are
// priced with the dataset fare rules and ranked with guaranteed seats first.

import { randomUUID } from "node:crypto";
import type { Journey, JourneyLeg, JourneyStation } from "../rail/journey.ts";
import { findAlternativeJourneys, RouteSearchError } from "../rail/routeSearch.ts";
import { journeySignature } from "../rail/ranking.ts";
import { addDays, istDateOf } from "../rail/time.ts";
import { CLASSES, CLASS_LABELS, fareFor, type ClassCode, type Quota } from "./fares.ts";
import {
  daysBetween,
  getSeatMap,
  planBerths,
  segmentAvailability,
  type AvailabilityStatus,
  type BerthType,
  type PassengerPlan,
  type SeatMap,
} from "./inventory.ts";
import { loadTimetable, type Timetable } from "./timetable.ts";

export const PREFERENCES = ["balanced", "cheapest", "fastest", "confirmed"] as const;
export type Preference = (typeof PREFERENCES)[number];

export type PlanRequest = {
  from: string;
  to: string;
  /** Travel date, YYYY-MM-DD (IST). */
  date: string;
  /** Earliest departure HH:MM; defaults to 00:00, or the current time when the date is today. */
  time?: string;
  classCode: ClassCode;
  passengers: number;
  preference?: Preference;
  berthPreference?: BerthType;
  maxTransfers?: number;
  /** Max berth changes allowed within one train when splitting. */
  maxBerthChanges?: number;
  /** Also search this many days either side of `date` (0-2). */
  flexibleDays?: number;
};

export type LegStatus = "CONFIRMED" | "BERTH_CHANGE" | "TATKAL" | "TATKAL_BERTH_CHANGE" | Exclude<AvailabilityStatus, "AVAILABLE">;

export type BerthAssignment = {
  passenger: number;
  pieces: { berth: string; type: string; from: JourneyStation; to: JourneyStation }[];
};

export type PlannedLeg = JourneyLeg & {
  classCode: ClassCode;
  quota: Quota;
  status: LegStatus;
  /** Seats free for the whole leg in the quota (0 when only a berth-change plan exists). */
  seatsAvailable: number;
  racPosition: number | null;
  waitlistPosition: number | null;
  confirmChance: number;
  berths: BerthAssignment[];
  /** Stations where some passenger changes berth on this train. */
  berthChangeStations: JourneyStation[];
  fare: number;
  /** The fare as one ticket for the whole leg (what a berth-change plan is compared against). */
  singleTicketFare: number;
  /** Internal references used when booking. */
  ref: { stopFrom: number; stopTo: number; stopCount: number; demandIndex: number; daysBefore: number };
};

export type PlanOption = {
  id: string;
  rank: number;
  journey: Omit<Journey, "legs">;
  legs: PlannedLeg[];
  classCode: ClassCode;
  passengers: number;
  totalFare: number;
  /** Every leg has a berth for every passenger right now. */
  guaranteed: boolean;
  confirmChance: number;
  berthChanges: number;
  tags: string[];
  summary: string;
};

export type ClassQuote = { classCode: ClassCode; label: string; fare: number; status: LegStatus; confirmChance: number };

export type PlanResult = {
  request: Required<Omit<PlanRequest, "berthPreference">> & { berthPreference?: BerthType };
  options: PlanOption[];
  /** Price and availability of the top option in every class. */
  classComparison: ClassQuote[];
  notes: string[];
};

export class PlanError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ---- Option cache (for booking by id) -----------------------------------------------------

const OPTION_TTL_MS = 30 * 60_000;
const optionCache = new Map<string, { option: PlanOption; ownerId: string; expires: number }>();

export function rememberOption(ownerId: string, option: PlanOption) {
  const now = Date.now();
  if (optionCache.size > 5000) for (const [k, v] of optionCache) if (v.expires < now) optionCache.delete(k);
  optionCache.set(option.id, { option, ownerId, expires: now + OPTION_TTL_MS });
}

export function recallOption(ownerId: string, id: string): PlanOption | null {
  const hit = optionCache.get(id);
  if (!hit || hit.ownerId !== ownerId || hit.expires < Date.now()) return null;
  return hit.option;
}

// ---- Helpers ------------------------------------------------------------------------------

export const todayIst = () => istDateOf(new Date());
const nowIstClock = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 16);

function legMap(tt: Timetable, leg: Pick<JourneyLeg, "trainNumber" | "originDate">, classCode: ClassCode): SeatMap | null {
  const meta = tt.meta.get(leg.trainNumber);
  const train = tt.trains.find((t) => t.number === leg.trainNumber);
  if (!meta || !train) return null;
  return getSeatMap({ trainNumber: leg.trainNumber, originDate: leg.originDate, classCode, stopCount: train.stops.length, demandIndex: meta.demandIndex });
}

function stationAt(tt: Timetable, trainNumber: string, index: number): JourneyStation {
  const train = tt.trains.find((t) => t.number === trainNumber)!;
  const id = train.stops[index]!.stationId;
  const s = tt.stationsByCode.get(id);
  return { id, code: id, name: s?.name ?? id };
}

function distanceBetween(tt: Timetable, trainNumber: string, from: number, to: number) {
  const train = tt.trains.find((t) => t.number === trainNumber)!;
  return Math.round(train.stops[to]!.distanceKm - train.stops[from]!.distanceKm);
}

/** Fare of a berth plan: each berth piece is its own ticket. */
function planFare(tt: Timetable, trainNumber: string, classCode: ClassCode, quota: Quota, plans: PassengerPlan[]) {
  let total = 0;
  for (const plan of plans) for (const piece of plan) total += fareFor(classCode, quota, distanceBetween(tt, trainNumber, piece.from, piece.to));
  return total;
}

function describeBerths(tt: Timetable, trainNumber: string, plans: PassengerPlan[]): BerthAssignment[] {
  return plans.map((plan, i) => ({
    passenger: i + 1,
    pieces: plan.map((p) => ({ berth: p.berth.label, type: p.berth.type, from: stationAt(tt, trainNumber, p.from), to: stationAt(tt, trainNumber, p.to) })),
  }));
}

export type LegCheck = Omit<PlannedLeg, keyof JourneyLeg | "ref" | "classCode"> & { plans: PassengerPlan[] | null };

/**
 * Seats for one leg right now: single berths, then berth changes, then Tatkal, then the queue.
 * Shared by the planner and by booking (which re-checks at booking time).
 */
export function checkLeg(
  tt: Timetable,
  leg: Pick<JourneyLeg, "trainNumber" | "originDate"> & { stopFrom: number; stopTo: number },
  classCode: ClassCode,
  passengers: number,
  daysBefore: number,
  opts: { berthPreference?: BerthType; maxBerthChanges?: number } = {},
): LegCheck | null {
  const map = legMap(tt, leg, classCode);
  if (!map) return null;
  const km = distanceBetween(tt, leg.trainNumber, leg.stopFrom, leg.stopTo);
  const query = { from: leg.stopFrom, to: leg.stopTo, daysBefore, passengers };
  const changeStations = (plans: PassengerPlan[]) => {
    const seen = new Map<string, JourneyStation>();
    for (const plan of plans) for (const piece of plan.slice(1)) {
      const s = stationAt(tt, leg.trainNumber, piece.from);
      seen.set(s.id, s);
    }
    return [...seen.values()];
  };

  let queued: LegCheck | null = null;
  for (const quota of ["GN", "TQ"] as const) {
    const avail = segmentAvailability(map, { ...query, quota });
    const singleTicketFare = fareFor(classCode, quota, km, passengers);
    const plans = planBerths(map, {
      ...query,
      quota,
      ...(opts.berthPreference && { preference: opts.berthPreference }),
      maxChanges: avail.status === "AVAILABLE" ? 0 : (opts.maxBerthChanges ?? 2),
    });
    if (!plans) {
      if (quota === "TQ") continue;
      // Keep the general-quota queue answer in case Tatkal is not open or also full.
      queued = {
        quota,
        status: avail.status === "AVAILABLE" ? "WAITLIST" : avail.status,
        seatsAvailable: 0,
        racPosition: avail.racPosition,
        waitlistPosition: avail.waitlistPosition,
        confirmChance: avail.confirmChance,
        berths: [],
        berthChangeStations: [],
        fare: singleTicketFare,
        singleTicketFare,
        plans: null,
      };
      continue;
    }
    const changes = plans.some((p) => p.length > 1);
    return {
      quota,
      status: quota === "GN" ? (changes ? "BERTH_CHANGE" : "CONFIRMED") : changes ? "TATKAL_BERTH_CHANGE" : "TATKAL",
      seatsAvailable: avail.seatsAvailable,
      racPosition: null,
      waitlistPosition: null,
      confirmChance: 1,
      berths: describeBerths(tt, leg.trainNumber, plans),
      berthChangeStations: changeStations(plans),
      fare: changes ? planFare(tt, leg.trainNumber, classCode, quota, plans) : singleTicketFare,
      singleTicketFare,
      plans,
    };
  }
  return queued;
}

const isSeated = (s: LegStatus) => s === "CONFIRMED" || s === "BERTH_CHANGE" || s === "TATKAL" || s === "TATKAL_BERTH_CHANGE";

function score(o: PlanOption, preference: Preference): number {
  const minutes = o.journey.totalDurationMinutes + o.journey.transferCount * 60;
  const risk = 1 - o.confirmChance;
  const changes = o.berthChanges * 45;
  switch (preference) {
    case "cheapest":
      return o.totalFare + risk * 3000 + minutes * 0.2;
    case "fastest":
      return minutes + changes + risk * 1500;
    case "confirmed":
      return risk * 10_000 + changes + minutes * 0.5 + o.totalFare * 0.05;
    default:
      return minutes + changes + o.totalFare / (8 * o.passengers) + risk * 2400;
  }
}

/**
 * The route search is tuned for the fastest arrival and prunes slower journeys, but a slower
 * train with seats beats a fast one without. So sweep the departure window in 3-hour steps (and
 * neighbouring dates when flexible) and merge the distinct journeys.
 */
async function searchJourneys(
  tt: Timetable,
  q: { from: string; to: string; date: string; time: string; maxTransfers: number; flexibleDays: number; today: string },
): Promise<Journey[]> {
  const seen = new Map<string, Journey>();
  const dates: { date: string; time: string }[] = [];
  for (let d = -q.flexibleDays; d <= q.flexibleDays; d++) {
    const date = addDays(q.date, d);
    if (date < q.today) continue;
    dates.push({ date, time: date === q.date ? q.time : date === q.today ? nowIstClock() : "00:00" });
  }
  for (const { date, time } of dates) {
    const [h, m] = time.split(":").map(Number) as [number, number];
    for (let start = h * 60 + m; start < 24 * 60; start += 180) {
      const clock = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
      try {
        const { journeys } = await findAlternativeJourneys(
          tt.rail,
          { sourceId: q.from, destinationId: q.to, date, earliestDeparture: clock },
          { maxTransfers: q.maxTransfers, maxResults: 8, beamWidth: 10, maxInitialWaitMinutes: 3 * 60, maxArrivalSlackMinutes: 24 * 60 },
        );
        for (const j of journeys) {
          const key = journeySignature(j);
          if (!seen.has(key)) seen.set(key, j);
        }
      } catch (err) {
        if (err instanceof RouteSearchError) throw new PlanError(err.message);
        throw err;
      }
    }
  }
  return [...seen.values()];
}

// ---- Planner ------------------------------------------------------------------------------

export async function planTrip(input: PlanRequest, ownerId?: string): Promise<PlanResult> {
  const tt = await loadTimetable();
  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (!tt.stationsByCode.has(from)) throw new PlanError(`Unknown station code: ${from}`);
  if (!tt.stationsByCode.has(to)) throw new PlanError(`Unknown station code: ${to}`);
  if (!CLASSES.includes(input.classCode)) throw new PlanError(`class must be one of ${CLASSES.join(", ")}`);
  if (!Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > 6) throw new PlanError("passengers must be between 1 and 6");

  const today = todayIst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < today) throw new PlanError("date must be today or later (YYYY-MM-DD)");
  if (daysBetween(today, input.date) > 120) throw new PlanError("Bookings open 120 days before travel; choose an earlier date");
  const time = input.time ?? (input.date === today ? nowIstClock() : "00:00");
  const preference = input.preference ?? "balanced";
  const maxTransfers = input.maxTransfers ?? 2;
  const maxBerthChanges = input.maxBerthChanges ?? 2;
  const request = { from, to, date: input.date, time, flexibleDays: Math.min(2, Math.max(0, input.flexibleDays ?? 0)), classCode: input.classCode, passengers: input.passengers, preference, maxTransfers, maxBerthChanges, ...(input.berthPreference && { berthPreference: input.berthPreference }) };

  const flexibleDays = Math.min(2, Math.max(0, input.flexibleDays ?? 0));
  const journeys = await searchJourneys(tt, { from, to, date: input.date, time, maxTransfers, flexibleDays, today });

  // Seat-hunting may board upstream or change at a station slightly off the line, but not zig-zag
  // across the country: drop journeys much longer than the shortest one found.
  const distance = (j: Journey) => j.legs.reduce((n, l) => n + l.distanceKm, 0);
  const shortest = Math.min(...journeys.map(distance));
  const sensible = journeys.filter((j) => distance(j) <= shortest * 1.5 + 100);

  const options: PlanOption[] = [];
  const closed: string[] = [];
  for (const journey of sensible) {
    const legs: PlannedLeg[] = [];
    for (const leg of journey.legs) {
      const meta = tt.meta.get(leg.trainNumber)!;
      const train = tt.trains.find((t) => t.number === leg.trainNumber)!;
      const stopFrom = meta.stopIndex.get(leg.from.id)!;
      const stopTo = meta.stopIndex.get(leg.to.id)!;
      const daysBefore = Math.max(0, daysBetween(today, leg.originDate));
      const check = checkLeg(tt, { ...leg, stopFrom, stopTo }, input.classCode, input.passengers, daysBefore, {
        ...(input.berthPreference && { berthPreference: input.berthPreference }),
        maxBerthChanges,
      });
      if (!check) break;
      const { plans: _plans, ...rest } = check;
      legs.push({ ...leg, ...rest, classCode: input.classCode, ref: { stopFrom, stopTo, stopCount: train.stops.length, demandIndex: meta.demandIndex, daysBefore } });
    }
    if (legs.length !== journey.legs.length) continue;

    const guaranteed = legs.every((l) => isSeated(l.status));
    const berthChanges = legs.reduce((n, l) => n + Math.max(0, ...l.berths.map((b) => b.pieces.length - 1)), 0);
    const { legs: _legs, ...journeyRest } = journey;
    const option: PlanOption = {
      id: randomUUID(),
      rank: 0,
      journey: journeyRest,
      legs,
      classCode: input.classCode,
      passengers: input.passengers,
      totalFare: legs.reduce((n, l) => n + l.fare, 0),
      guaranteed,
      confirmChance: Math.round(legs.reduce((p, l) => p * l.confirmChance, 1) * 100) / 100,
      berthChanges,
      tags: [],
      summary: "",
    };
    if (legs.some((l) => l.status === "CLOSED")) {
      closed.push(`${legs.map((l) => `${l.trainNumber} ${l.trainName}`).join(" + ")} is fully booked (waitlist closed)`);
    } else options.push(option);
  }

  options.sort((a, b) => Number(b.guaranteed) - Number(a.guaranteed) || score(a, preference) - score(b, preference));
  // Variants that only differ in where you change (KYN vs TNA) clutter the list: keep the best
  // per train sequence and run date.
  const distinct = new Set<string>();
  const ranked = options.filter((o) => {
    const key = o.legs.map((l) => `${l.trainNumber}@${l.originDate}`).join("+");
    if (distinct.has(key)) return false;
    distinct.add(key);
    return true;
  }).slice(0, 10);
  options.length = 0;
  options.push(...ranked);
  options.forEach((o, i) => (o.rank = i + 1));
  tag(options);
  for (const o of options) {
    o.summary = summarize(o);
    if (ownerId) rememberOption(ownerId, o);
  }

  const notes: string[] = [
    "Timetables are the Sept 2024 snapshot; service days are not in the source, so every train is assumed to run daily.",
  ];
  for (const c of closed.slice(0, 3)) notes.push(c + ".");
  if (!options.length) notes.push("No bookable combination found. Try another date (or flexible dates), another class, or allow more transfers.");
  if (options.some((o) => o.berthChanges > 0)) notes.push("BERTH_CHANGE means separate tickets on the same train: you move to another berth at the station shown, without leaving the train.");

  return { request, options, classComparison: options[0] ? compareClasses(tt, options[0], today) : [], notes };
}

function compareClasses(tt: Timetable, option: PlanOption, today: string): ClassQuote[] {
  return CLASSES.map((classCode) => {
    let fare = 0;
    let chance = 1;
    let status: LegStatus = "CONFIRMED";
    for (const leg of option.legs) {
      const check = checkLeg(tt, { ...leg, stopFrom: leg.ref.stopFrom, stopTo: leg.ref.stopTo }, classCode, option.passengers, Math.max(0, daysBetween(today, leg.originDate)));
      if (!check) continue;
      fare += check.fare;
      chance *= check.confirmChance;
      // Report the weakest leg: any queued leg wins over seated ones, then berth changes over plain.
      if (isSeated(status) && (!isSeated(check.status) || status === "CONFIRMED")) status = check.status;
    }
    return { classCode, label: CLASS_LABELS[classCode], fare, status, confirmChance: Math.round(chance * 100) / 100 };
  });
}

function tag(options: PlanOption[]) {
  if (!options.length) return;
  options[0]!.tags.push("Recommended");
  const min = (pool: PlanOption[], f: (o: PlanOption) => number) => pool.reduce((best, o) => (f(o) < f(best) ? o : best));
  const guaranteed = options.filter((o) => o.guaranteed);
  if (guaranteed.length) {
    min(guaranteed, (o) => o.totalFare).tags.push("Cheapest confirmed");
    min(guaranteed, (o) => o.journey.totalDurationMinutes).tags.push("Fastest confirmed");
  }
  const cheapest = min(options, (o) => o.totalFare);
  if (!cheapest.tags.includes("Cheapest confirmed")) cheapest.tags.push("Lowest fare");
  const shortest = Math.min(...options.map((o) => o.legs.reduce((n, l) => n + l.distanceKm, 0)));
  for (const o of options) {
    const extra = Math.round(o.legs.reduce((n, l) => n + l.distanceKm, 0) - shortest);
    if (extra > 150) o.tags.push(`Detour +${extra} km`);
    if (o.berthChanges) o.tags.push("Berth change");
    if (o.legs.some((l) => l.quota === "TQ")) o.tags.push("Tatkal");
    if (!o.guaranteed) o.tags.push(`${Math.round(o.confirmChance * 100)}% confirm chance`);
  }
}

function summarize(o: PlanOption): string {
  const legs = o.legs
    .map((l) => {
      const status =
        l.status === "WAITLIST" ? `WL ${l.waitlistPosition}` : l.status === "RAC" ? `RAC ${l.racPosition}` : l.status.replace(/_/g, " ").toLowerCase();
      const change = l.berthChangeStations.length ? ` (change berth at ${l.berthChangeStations.map((s) => s.name).join(", ")})` : "";
      return `${l.trainNumber} ${l.trainName} ${l.from.code}→${l.to.code} [${status}${change}]`;
    })
    .join(" + ");
  return `#${o.rank}: ${legs}; ₹${o.totalFare}; ${Math.floor(o.journey.totalDurationMinutes / 60)}h${String(o.journey.totalDurationMinutes % 60).padStart(2, "0")}m`;
}
