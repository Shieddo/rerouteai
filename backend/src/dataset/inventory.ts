// Berth-level seat inventory. One deterministic simulation per (train run, class) is the single
// source of truth for seat availability, RAC/waitlist positions, chart confirmation and
// "intermediate berth" (berth-change) plans. scripts/alignDataset.ts regenerates the published
// CSVs from this same code, so the dataset and the app always agree.
//
// Model
//  - A train run with n stops has n-1 segments (stop i -> i+1). Each berth holds bookings that
//    occupy a contiguous range of segments.
//  - Every simulated booking has `bookedAt` (days before the run's origin date it was made) and
//    optionally `cancelAt` (days before departure it is cancelled). Looking at the inventory
//    "d days before departure" shows bookings with bookedAt >= d that are not yet cancelled
//    (cancelAt < d or never). So seats only fill up as departure nears, and overlapping segments
//    are always consistent with each other.
//  - Requests that found no seat form a queue per segment: RAC first (classes with side-lower
//    berths), then waitlist, then CLOSED past the waitlist limit.
//  - A queued passenger is confirmed at chart time when enough berths covering their segment are
//    freed by cancellations still to come.
//  - Tatkal (TQ) has its own pool (every 10th berth) and opens 1 day before departure.
//  - Bookings made through the app are an overlay on top of the simulation.

import { addDays, weekdayOf } from "../rail/time.ts";
import type { ClassCode, Quota } from "./fares.ts";

export type AvailabilityStatus = "AVAILABLE" | "RAC" | "WAITLIST" | "CLOSED";

type Layout = { coaches: string[]; perCoach: number; types: string[]; racShare: number; wlLimit: number };

export const LAYOUTS: Record<ClassCode, Layout> = {
  SL: { coaches: ["S1", "S2", "S3"], perCoach: 72, types: ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"], racShare: 0.08, wlLimit: 200 },
  "3A": { coaches: ["B1", "B2"], perCoach: 64, types: ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"], racShare: 0.08, wlLimit: 150 },
  "2A": { coaches: ["A1", "A2"], perCoach: 46, types: ["LB", "UB", "LB", "UB", "SL", "SU"], racShare: 0.08, wlLimit: 100 },
  CC: { coaches: ["C1", "C2"], perCoach: 78, types: ["WS", "MS", "AS", "AS", "MS", "WS"], racShare: 0, wlLimit: 150 },
};

export const BERTH_TYPES = ["LB", "MB", "UB", "SL", "SU", "WS", "MS", "AS"] as const;
export type BerthType = (typeof BERTH_TYPES)[number];

/** Days before departure at which booking opens, and when Tatkal opens. */
export const BOOKING_HORIZON_DAYS = 120;
export const TATKAL_OPENS_DAYS = 1;

type SimBooking = { from: number; to: number; bookedAt: number; cancelAt: number | null };
type QueueRequest = { from: number; to: number; bookedAt: number; quota: Quota; promotedAt: number | null };
export type Allocation = { bookingId: string; berth: number; from: number; to: number };
export type QueueEntry = { bookingId: string; from: number; to: number; quota: Quota };

export type BerthInfo = { index: number; coach: string; number: number; type: string; label: string };

export type SeatMap = {
  key: string;
  classCode: ClassCode;
  segments: number;
  capacity: number;
  berths: SimBooking[][];
  queue: QueueRequest[];
  /** App bookings on top of the simulation. Mutated by allocate/release. */
  allocations: Allocation[];
  appQueue: QueueEntry[];
};

// ---- Deterministic randomness -----------------------------------------------------------

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Demand -------------------------------------------------------------------------------

const PEAK_MONTHS = new Set([1, 4, 5, 6, 10, 11, 12]);
export const isPeakSeason = (date: string) => PEAK_MONTHS.has(Number(date.slice(5, 7)));
export const isWeekend = (date: string) => ["fri", "sat", "sun"].includes(weekdayOf(date));

/** When a booking was made, in (fractional) days before departure: most book weeks ahead. */
function sampleBookedAt(r: () => number): number {
  const u = r();
  if (u < 0.66) return 30 + r() * 90;
  if (u < 0.8) return 14 + r() * 16;
  if (u < 0.89) return 7 + r() * 7;
  if (u < 0.96) return 1 + r() * 6;
  return r();
}

/** Seat-segments requested per seat-segment of capacity, before run-level variation. */
const DEMAND_BY_CLASS: Record<ClassCode, number> = { SL: 1.32, "3A": 1.26, "2A": 1.2, CC: 1.22 };
const CANCEL_RATE = 0.1;
const TATKAL_SHARE = 0.1;

export const isTatkalBerth = (berth: number) => berth % 10 === 9;

function gaussian(r: () => number) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

type Event = { at: number; kind: "request"; req: QueueRequest } | { at: number; kind: "cancel"; berth: number; booking: SimBooking };

/**
 * Replays a run's booking history: requests arrive (earliest first) and take the first berth in
 * their quota's pool that is free for their whole ride, else join the queue. Cancellations free
 * the berth and promote the first queued requests that now fit.
 */
function generate(key: string, classCode: ClassCode, segments: number, originDate: string, demandIndex: number): SeatMap {
  const layout = LAYOUTS[classCode];
  const capacity = layout.coaches.length * layout.perCoach;
  const r = rng(hash(key));
  const runDemand =
    DEMAND_BY_CLASS[classCode] *
    demandIndex *
    (isPeakSeason(originDate) ? 1.08 : 0.94) *
    (isWeekend(originDate) ? 1.04 : 1) *
    Math.exp(0.15 * gaussian(r));

  // Requests until the requested seat-segments reach the run's demand.
  const events: Event[] = [];
  const target = runDemand * capacity * segments;
  for (let volume = 0; volume < target; ) {
    // Mostly long-distance travellers boarding near the origin, plus short hops anywhere.
    const short = r() < 0.5;
    const from = Math.floor(segments * (short ? r() : Math.pow(r(), 1.4)));
    const span = segments - from - 1;
    const to = from + 1 + Math.floor(short ? Math.min(span, segments * 0.25) * r() : span * Math.pow(r(), 0.55));
    const quota: Quota = r() < TATKAL_SHARE ? "TQ" : "GN";
    const bookedAt = quota === "TQ" ? r() * (TATKAL_OPENS_DAYS + 1) : sampleBookedAt(r);
    events.push({ at: bookedAt, kind: "request", req: { from, to, bookedAt, quota, promotedAt: null } });
    volume += to - from;
  }
  events.sort((a, b) => b.at - a.at);

  const words = Math.ceil(segments / 32);
  const occupied = new Uint32Array(capacity * words);
  const rangeMask = (from: number, to: number) => {
    const mask = new Uint32Array(words);
    for (let s = from; s < to; s++) mask[s >> 5]! |= 1 << (s & 31);
    return mask;
  };
  const fits = (b: number, mask: Uint32Array) => {
    for (let w = 0; w < words; w++) if (occupied[b * words + w]! & mask[w]!) return false;
    return true;
  };
  const mark = (b: number, mask: Uint32Array, on: boolean) => {
    for (let w = 0; w < words; w++) occupied[b * words + w] = on ? occupied[b * words + w]! | mask[w]! : occupied[b * words + w]! & ~mask[w]!;
  };

  const queueLimit = Math.round(capacity * layout.racShare) + layout.wlLimit;
  const berths: SimBooking[][] = Array.from({ length: capacity }, () => []);
  const queue: QueueRequest[] = [];
  const pending: Event[] = []; // cancellations, merged into the timeline as they are created

  const seat = (req: QueueRequest, at: number): boolean => {
    const mask = rangeMask(req.from, req.to);
    for (let b = 0; b < capacity; b++) {
      if ((req.quota === "TQ") !== isTatkalBerth(b) || !fits(b, mask)) continue;
      mark(b, mask, true);
      const cancelAt = r() < CANCEL_RATE && at > 0.05 ? r() * at : null;
      const booking: SimBooking = { from: req.from, to: req.to, bookedAt: at, cancelAt };
      berths[b]!.push(booking);
      if (cancelAt !== null) pending.push({ at: cancelAt, kind: "cancel", berth: b, booking });
      return true;
    }
    return false;
  };

  let i = 0;
  while (i < events.length || pending.length) {
    // Next event in time order (larger "days before" first).
    pending.sort((a, b) => a.at - b.at);
    const nextCancel = pending[pending.length - 1];
    const nextRequest = events[i];
    if (nextCancel && (!nextRequest || nextCancel.at >= nextRequest.at)) {
      pending.pop();
      if (nextCancel.kind !== "cancel") continue;
      const { booking, berth, at } = nextCancel;
      mark(berth, rangeMask(booking.from, booking.to), false);
      // Promote queued requests (earliest first) into the freed space.
      for (const q of queue) {
        if (q.promotedAt !== null || q.quota !== ((isTatkalBerth(berth) ? "TQ" : "GN") as Quota)) continue;
        if (q.from < booking.to && q.to > booking.from && seat(q, at)) q.promotedAt = at;
      }
      continue;
    }
    i++;
    if (nextRequest!.kind !== "request" || seat(nextRequest!.req, nextRequest!.at)) continue;
    // No berth: join the queue unless it is already past RAC + waitlist limit on this ride.
    const req = nextRequest!.req;
    const ahead = queue.filter((q) => q.promotedAt === null && q.quota === req.quota && q.from < req.to && q.to > req.from).length;
    if (ahead < queueLimit) queue.push(req);
  }

  return { key, classCode, segments, capacity, berths, queue, allocations: [], appQueue: [] };
}

// ---- Seat map registry --------------------------------------------------------------------

const maps = new Map<string, SeatMap>();
const MAX_CACHED = 4000;

export type RunRef = { trainNumber: string; originDate: string; classCode: ClassCode; stopCount: number; demandIndex: number };

export function seatMapKey(run: Pick<RunRef, "trainNumber" | "originDate" | "classCode">) {
  return `${run.trainNumber}|${run.originDate}|${run.classCode}`;
}

export function getSeatMap(run: RunRef): SeatMap {
  const key = seatMapKey(run);
  let map = maps.get(key);
  if (!map) {
    // Only maps without app bookings may be dropped; they are cheap to regenerate identically.
    if (maps.size >= MAX_CACHED) {
      for (const [k, m] of maps) if (!m.allocations.length && !m.appQueue.length) maps.delete(k);
    }
    map = generate(key, run.classCode, run.stopCount - 1, run.originDate, run.demandIndex);
    maps.set(key, map);
  }
  return map;
}

/** Test hook. */
export function resetSeatMaps() {
  maps.clear();
}

// ---- Queries ------------------------------------------------------------------------------

export function berthInfo(classCode: ClassCode, index: number): BerthInfo {
  const layout = LAYOUTS[classCode];
  const coach = layout.coaches[Math.floor(index / layout.perCoach)]!;
  const number = (index % layout.perCoach) + 1;
  const type = layout.types[(number - 1) % layout.types.length]!;
  return { index, coach, number, type, label: `${coach}-${number} (${type})` };
}

const active = (b: SimBooking, d: number) => b.bookedAt >= d && (b.cancelAt === null || d > b.cancelAt);
const overlaps = (x: { from: number; to: number }, from: number, to: number) => x.from < to && x.to > from;

function inPool(berth: number, quota: Quota) {
  return quota === "TQ" ? isTatkalBerth(berth) : !isTatkalBerth(berth);
}

/** Whether berth `b` is free over every segment of [from, to) at `d` days before departure. */
function berthFree(map: SeatMap, b: number, from: number, to: number, d: number, ignore?: ReadonlySet<string>): boolean {
  for (const booking of map.berths[b]!) if (overlaps(booking, from, to) && active(booking, d)) return false;
  for (const a of map.allocations) if (a.berth === b && overlaps(a, from, to) && !ignore?.has(a.bookingId)) return false;
  return true;
}

/** Furthest stop index reachable on berth `b` starting at segment `from`, staying free. */
function freeRunEnd(map: SeatMap, b: number, from: number, limit: number, d: number): number {
  let end = limit;
  for (const booking of map.berths[b]!) {
    if (!active(booking, d) || booking.to <= from || booking.from >= end) continue;
    if (booking.from <= from) return from;
    end = booking.from;
  }
  for (const a of map.allocations) {
    if (a.berth !== b || a.to <= from || a.from >= end) continue;
    if (a.from <= from) return from;
    end = a.from;
  }
  return end;
}

export type SegmentAvailability = {
  status: AvailabilityStatus;
  /** Whole-segment free berths in the quota's pool (AVAILABLE only; 0 otherwise). */
  seatsAvailable: number;
  /** 1-based RAC or waitlist position for the first passenger, when queued. */
  racPosition: number | null;
  waitlistPosition: number | null;
  /** Ground truth: whether this request would be confirmed when the chart is prepared. */
  confirmedByChart: boolean;
  /** What a passenger may see: estimated chance of a confirmed berth at chart time (0-1). */
  confirmChance: number;
  /** When CLOSED, why. */
  closedReason?: "TATKAL_NOT_OPEN" | "WAITLIST_FULL" | "BOOKING_NOT_OPEN";
};

export type Query = { from: number; to: number; daysBefore: number; quota: Quota; passengers: number };

function clampDays(d: number) {
  return Math.max(0, Math.min(BOOKING_HORIZON_DAYS, Math.floor(d)));
}

export function segmentAvailability(map: SeatMap, q: Query): SegmentAvailability {
  const d = clampDays(q.daysBefore);
  const closed = (closedReason: SegmentAvailability["closedReason"]): SegmentAvailability => ({
    status: "CLOSED",
    seatsAvailable: 0,
    racPosition: null,
    waitlistPosition: null,
    confirmedByChart: false,
    confirmChance: 0,
    closedReason,
  });
  if (q.daysBefore > BOOKING_HORIZON_DAYS) return closed("BOOKING_NOT_OPEN");
  if (q.quota === "TQ" && d > TATKAL_OPENS_DAYS) return closed("TATKAL_NOT_OPEN");

  let free = 0;
  let freedLater = 0; // occupied now, but every blocking booking is cancelled before the chart
  let blockingBookings = 0;
  for (let b = 0; b < map.capacity; b++) {
    if (!inPool(b, q.quota)) continue;
    let blocked = false;
    let allCancel = true;
    for (const booking of map.berths[b]!) {
      if (!overlaps(booking, q.from, q.to) || !active(booking, d)) continue;
      blocked = true;
      blockingBookings++;
      if (booking.cancelAt === null) allCancel = false;
    }
    for (const a of map.allocations) {
      if (a.berth === b && overlaps(a, q.from, q.to)) {
        blocked = true;
        allCancel = false;
      }
    }
    if (!blocked) free++;
    else if (allCancel) freedLater++;
  }

  if (free >= q.passengers) {
    return { status: "AVAILABLE", seatsAvailable: free, racPosition: null, waitlistPosition: null, confirmedByChart: true, confirmChance: 1 };
  }

  const ahead =
    map.queue.filter((r) => r.quota === q.quota && r.bookedAt >= d && (r.promotedAt === null || r.promotedAt < d) && overlaps(r, q.from, q.to)).length +
    map.appQueue.filter((e) => e.quota === q.quota && overlaps(e, q.from, q.to)).length;
  // Positions behind any berths still free (fewer than the party size).
  const position = ahead + 1;
  const layout = LAYOUTS[map.classCode];
  const racCap = q.quota === "TQ" ? 0 : Math.round(map.capacity * layout.racShare);
  const lastPosition = position + q.passengers - 1;
  const confirmedByChart = lastPosition <= free + freedLater;

  // Without knowing the future: expect ~CANCEL_RATE of the bookings in the way to cancel.
  const expected = free + blockingBookings * CANCEL_RATE * Math.min(1, d / 7 + 0.25);
  const spread = Math.max(2, expected * 0.35);
  const confirmChance = Math.round((1 / (1 + Math.exp((lastPosition - expected) / spread))) * 100) / 100;

  if (position <= racCap) {
    return { status: "RAC", seatsAvailable: 0, racPosition: position, waitlistPosition: null, confirmedByChart, confirmChance: Math.max(confirmChance, 0.5) };
  }
  const wl = position - racCap;
  if (wl > layout.wlLimit) return closed("WAITLIST_FULL");
  return { status: "WAITLIST", seatsAvailable: 0, racPosition: null, waitlistPosition: wl, confirmedByChart, confirmChance };
}

export type BerthPiece = { berth: BerthInfo; from: number; to: number };
export type PassengerPlan = BerthPiece[];

const preferenceRank = (map: SeatMap, b: number, pref: BerthType | undefined) =>
  pref && berthInfo(map.classCode, b).type === pref ? 0 : 1;

/**
 * Seats for every passenger over [from, to). Each passenger gets a single berth when one is free
 * for the whole ride; otherwise a chain of berths (change berth at an intermediate station on the
 * same train), chosen greedily by furthest reach, which minimises the number of changes.
 * Returns null when some passenger cannot be seated within `maxChanges` berth changes.
 */
export function planBerths(
  map: SeatMap,
  q: Query & { preference?: BerthType; maxChanges?: number },
): PassengerPlan[] | null {
  const d = clampDays(q.daysBefore);
  if (q.quota === "TQ" && d > TATKAL_OPENS_DAYS) return null;
  const maxChanges = q.maxChanges ?? 2;
  const used = new Set<number>();
  const plans: PassengerPlan[] = [];
  const pool = [...Array(map.capacity).keys()]
    .filter((b) => inPool(b, q.quota))
    .sort((a, b) => preferenceRank(map, a, q.preference) - preferenceRank(map, b, q.preference) || a - b);

  for (let p = 0; p < q.passengers; p++) {
    const whole = pool.find((b) => !used.has(b) && berthFree(map, b, q.from, q.to, d));
    if (whole !== undefined) {
      used.add(whole);
      plans.push([{ berth: berthInfo(map.classCode, whole), from: q.from, to: q.to }]);
      continue;
    }
    const pieces: BerthPiece[] = [];
    let at = q.from;
    while (at < q.to) {
      let best = -1;
      let bestEnd = at;
      for (const b of pool) {
        if (used.has(b)) continue;
        const end = freeRunEnd(map, b, at, q.to, d);
        if (end > bestEnd) {
          best = b;
          bestEnd = end;
        }
      }
      if (best < 0 || pieces.length > maxChanges) return null;
      pieces.push({ berth: berthInfo(map.classCode, best), from: at, to: bestEnd });
      at = bestEnd;
    }
    if (pieces.length - 1 > maxChanges) return null;
    for (const piece of pieces) used.add(piece.berth.index);
    plans.push(pieces);
  }
  return plans;
}

// ---- App bookings overlay -----------------------------------------------------------------

export function allocate(map: SeatMap, bookingId: string, plans: PassengerPlan[]) {
  for (const plan of plans) for (const piece of plan) map.allocations.push({ bookingId, berth: piece.berth.index, from: piece.from, to: piece.to });
}

export function enqueue(map: SeatMap, entry: QueueEntry, passengers: number) {
  for (let i = 0; i < passengers; i++) map.appQueue.push(entry);
}

export function release(map: SeatMap, bookingId: string) {
  map.allocations = map.allocations.filter((a) => a.bookingId !== bookingId);
  map.appQueue = map.appQueue.filter((e) => e.bookingId !== bookingId);
}

/** Days from `today` until `date` (both YYYY-MM-DD). */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export { addDays };
