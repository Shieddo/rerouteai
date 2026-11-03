// Simulated bookings on top of the berth inventory: book a planned option, auto-book the best
// option that meets the passenger's conditions, and cancel with the dataset refund rule. Freed
// berths are offered to waitlisted/RAC bookings in queue order, which is how cancellations
// confirm other passengers. Held in memory: a server restart clears them (like the dev users).

import { randomInt } from "node:crypto";
import type { JourneyStation } from "../rail/journey.ts";
import { REFUND_RULE, refundFor, refundRatio, type ClassCode, type Quota } from "./fares.ts";
import { allocate, daysBetween, enqueue, getSeatMap, planBerths, release, seatMapKey, type SeatMap } from "./inventory.ts";
import { checkLeg, planTrip, PlanError, recallOption, todayIst, type BerthAssignment, type LegStatus, type PlanOption, type PlanRequest } from "./planner.ts";
import { loadTimetable, type Timetable } from "./timetable.ts";

export type BookingStatus = "CONFIRMED" | "PARTIALLY_CONFIRMED" | "WAITLISTED" | "CANCELLED";

export type BookedLeg = {
  trainNumber: string;
  trainName: string;
  originDate: string;
  from: JourneyStation;
  to: JourneyStation;
  departure: string;
  arrival: string;
  classCode: ClassCode;
  quota: Quota;
  status: LegStatus;
  racPosition: number | null;
  waitlistPosition: number | null;
  berths: BerthAssignment[];
  berthChangeStations: JourneyStation[];
  fare: number;
  ref: { stopFrom: number; stopTo: number; stopCount: number; demandIndex: number };
};

export type BookingEvent = { at: string; message: string };

export type Booking = {
  pnr: string;
  createdAt: string;
  status: BookingStatus;
  passengers: number;
  classCode: ClassCode;
  source: JourneyStation;
  destination: JourneyStation;
  departure: string;
  arrival: string;
  legs: BookedLeg[];
  totalFare: number;
  refund: { amount: number; rule: string; daysBefore: number } | null;
  history: BookingEvent[];
};

type Stored = Booking & { ownerId: string };

export class BookingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const bookings = new Map<string, Stored>();
const MAX_ACTIVE_PER_USER = 20;

const seated = (s: LegStatus) => s === "CONFIRMED" || s === "BERTH_CHANGE" || s === "TATKAL" || s === "TATKAL_BERTH_CHANGE";
const now = () => new Date().toISOString();
const strip = ({ ownerId: _o, ...b }: Stored): Booking => structuredClone(b);

function newPnr(): string {
  let pnr: string;
  do pnr = String(randomInt(1_000_000_000, 9_999_999_999));
  while (bookings.has(pnr));
  return pnr;
}

function bookingStatus(legs: BookedLeg[]): BookingStatus {
  const n = legs.filter((l) => seated(l.status)).length;
  return n === legs.length ? "CONFIRMED" : n === 0 ? "WAITLISTED" : "PARTIALLY_CONFIRMED";
}

function mapFor(tt: Timetable, leg: BookedLeg): SeatMap {
  return getSeatMap({ trainNumber: leg.trainNumber, originDate: leg.originDate, classCode: leg.classCode, stopCount: leg.ref.stopCount, demandIndex: leg.ref.demandIndex });
}

/** Re-checks every leg of a planned option against current inventory and books it. */
export async function bookOption(ownerId: string, optionId: string, opts: { requireConfirmed?: boolean } = {}): Promise<Booking> {
  const option = recallOption(ownerId, optionId);
  if (!option) throw new BookingError("That option has expired or does not exist. Search again to get fresh options.", 404);
  return bookPlanned(ownerId, option, opts);
}

async function bookPlanned(ownerId: string, option: PlanOption, { requireConfirmed = false } = {}): Promise<Booking> {
  const active = [...bookings.values()].filter((b) => b.ownerId === ownerId && b.status !== "CANCELLED").length;
  if (active >= MAX_ACTIVE_PER_USER) throw new BookingError(`You can hold at most ${MAX_ACTIVE_PER_USER} active bookings. Cancel one first.`, 409);

  const tt = await loadTimetable();
  const today = todayIst();
  const pnr = newPnr();

  // Check all legs first so a failure books nothing.
  const checks = option.legs.map((leg) => {
    const daysBefore = daysBetween(today, leg.originDate);
    if (Date.parse(leg.departure) < Date.now()) throw new BookingError(`${leg.trainNumber} has already left ${leg.from.name}.`);
    const check = checkLeg(tt, { ...leg, stopFrom: leg.ref.stopFrom, stopTo: leg.ref.stopTo }, option.classCode, option.passengers, Math.max(0, daysBefore));
    if (!check || check.status === "CLOSED") throw new BookingError(`${leg.trainNumber} ${leg.trainName} is fully booked for ${leg.from.name} → ${leg.to.name}; waitlist closed.`, 409);
    if (requireConfirmed && !check.plans) {
      throw new BookingError(`${leg.trainNumber} ${leg.trainName} no longer has confirmed berths (${check.status} now).`, 409);
    }
    return check;
  });

  const legs: BookedLeg[] = option.legs.map((leg, i) => {
    const check = checks[i]!;
    const booked: BookedLeg = {
      trainNumber: leg.trainNumber,
      trainName: leg.trainName,
      originDate: leg.originDate,
      from: leg.from,
      to: leg.to,
      departure: leg.departure,
      arrival: leg.arrival,
      classCode: option.classCode,
      quota: check.quota,
      status: check.status,
      racPosition: check.racPosition,
      waitlistPosition: check.waitlistPosition,
      berths: check.berths,
      berthChangeStations: check.berthChangeStations,
      fare: check.fare,
      ref: { stopFrom: leg.ref.stopFrom, stopTo: leg.ref.stopTo, stopCount: leg.ref.stopCount, demandIndex: leg.ref.demandIndex },
    };
    const map = mapFor(tt, booked);
    if (check.plans) allocate(map, pnr, check.plans);
    else enqueue(map, { bookingId: pnr, from: booked.ref.stopFrom, to: booked.ref.stopTo, quota: check.quota }, option.passengers);
    return booked;
  });

  const status = bookingStatus(legs);
  const booking: Stored = {
    ownerId,
    pnr,
    createdAt: now(),
    status,
    passengers: option.passengers,
    classCode: option.classCode,
    source: option.journey.source,
    destination: option.journey.destination,
    departure: option.journey.departure,
    arrival: option.journey.arrival,
    legs,
    totalFare: legs.reduce((n, l) => n + l.fare, 0),
    refund: null,
    history: [{ at: now(), message: `Booked: ${legs.map((l) => `${l.trainNumber} ${l.status.replace(/_/g, " ")}`).join(", ")}` }],
  };
  bookings.set(pnr, booking);
  return strip(booking);
}

export type AutoBookRequest = PlanRequest & {
  /** Upper limit on the total fare, INR. */
  maxFare?: number;
  /** Book only options with confirmed berths on every leg (default true). */
  requireConfirmed?: boolean;
  /** Allow berth changes within a train (default true). */
  allowBerthChange?: boolean;
  /** Most transfers between trains the passenger accepts. */
  maxTransfers?: number;
};

export type AutoBookResult = {
  booking: Booking | null;
  attempts: { option: string; outcome: string }[];
  message: string;
};

/**
 * Booking automation: plan, then try options in rank order and book the first that meets the
 * conditions and still has the seats when we try to take them.
 */
export async function autoBook(ownerId: string, request: AutoBookRequest): Promise<AutoBookResult> {
  const requireConfirmed = request.requireConfirmed ?? true;
  const plan = await planTrip(request, ownerId);
  const attempts: AutoBookResult["attempts"] = [];
  for (const option of plan.options) {
    const label = option.summary;
    if (request.maxFare !== undefined && option.totalFare > request.maxFare) {
      attempts.push({ option: label, outcome: `skipped: ₹${option.totalFare} is over the ₹${request.maxFare} limit` });
      continue;
    }
    if (requireConfirmed && !option.guaranteed) {
      attempts.push({ option: label, outcome: "skipped: not confirmed on every leg" });
      continue;
    }
    if (request.allowBerthChange === false && option.berthChanges > 0) {
      attempts.push({ option: label, outcome: "skipped: needs a berth change" });
      continue;
    }
    try {
      const booking = await bookPlanned(ownerId, option, { requireConfirmed });
      attempts.push({ option: label, outcome: `booked PNR ${booking.pnr}` });
      return { booking, attempts, message: `Booked PNR ${booking.pnr} (${booking.status.toLowerCase()}), ₹${booking.totalFare}.` };
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      attempts.push({ option: label, outcome: `failed: ${err.message}` });
    }
  }
  return {
    booking: null,
    attempts,
    message: plan.options.length ? "No option met your conditions. Relax the fare limit, allow waitlist, or try flexible dates." : plan.notes.join(" "),
  };
}

export function listBookings(ownerId: string): Booking[] {
  return [...bookings.values()]
    .filter((b) => b.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(strip);
}

export function getBooking(ownerId: string, pnr: string): Booking | null {
  const b = bookings.get(pnr);
  return b && b.ownerId === ownerId ? strip(b) : null;
}

/** What cancelling now would refund, without cancelling. */
export function refundQuote(booking: Pick<Booking, "legs" | "totalFare" | "status">) {
  if (booking.status === "CANCELLED") return null;
  const daysBefore = Math.max(0, daysBetween(todayIst(), booking.legs[0]!.departure.slice(0, 10)));
  // Waitlisted legs never had a berth: refund in full.
  const amount = booking.legs.reduce((n, l) => n + (seated(l.status) || l.status === "RAC" ? refundFor(l.fare, daysBefore) : l.fare), 0);
  return { amount: Math.round(amount * 100) / 100, rule: REFUND_RULE, daysBefore, ratio: refundRatio(daysBefore) };
}

export async function cancelBooking(ownerId: string, pnr: string): Promise<{ booking: Booking; promoted: string[] }> {
  const stored = bookings.get(pnr);
  if (!stored || stored.ownerId !== ownerId) throw new BookingError("No booking with that PNR.", 404);
  if (stored.status === "CANCELLED") throw new BookingError("This booking is already cancelled.", 409);
  if (Date.parse(stored.legs[0]!.departure) < Date.now()) throw new BookingError("The journey has started; it can no longer be cancelled here.", 409);

  const quote = refundQuote(stored)!;
  const tt = await loadTimetable();
  const touched = new Map<string, SeatMap>();
  for (const leg of stored.legs) {
    const map = mapFor(tt, leg);
    release(map, pnr);
    touched.set(map.key, map);
  }
  stored.status = "CANCELLED";
  stored.refund = { amount: quote.amount, rule: quote.rule, daysBefore: quote.daysBefore };
  stored.history.push({ at: now(), message: `Cancelled ${quote.daysBefore} day(s) before departure; refund ₹${quote.amount}.` });

  const promoted = promoteQueued(tt, touched);
  return { booking: strip(stored), promoted };
}

/** Freed berths go to queued app bookings on the same train run, oldest booking first. */
function promoteQueued(tt: Timetable, maps: Map<string, SeatMap>): string[] {
  const promoted: string[] = [];
  const today = todayIst();
  const queued = [...bookings.values()]
    .filter((b) => b.status === "WAITLISTED" || b.status === "PARTIALLY_CONFIRMED")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const booking of queued) {
    for (const leg of booking.legs) {
      if (seated(leg.status)) continue;
      const map = maps.get(seatMapKey(leg));
      if (!map) continue;
      const plans = planBerths(map, {
        from: leg.ref.stopFrom,
        to: leg.ref.stopTo,
        daysBefore: Math.max(0, daysBetween(today, leg.originDate)),
        quota: leg.quota,
        passengers: booking.passengers,
        maxChanges: 2,
      });
      if (!plans) continue;
      // Leaves the queue. A journey never reboards the same train, so this booking has no other
      // seats on this map for release() to drop.
      release(map, booking.pnr);
      allocate(map, booking.pnr, plans);
      leg.status = plans.some((p) => p.length > 1) ? "BERTH_CHANGE" : "CONFIRMED";
      leg.racPosition = null;
      leg.waitlistPosition = null;
      leg.berths = plans.map((plan, i) => ({
        passenger: i + 1,
        pieces: plan.map((p) => ({ berth: p.berth.label, type: p.berth.type, from: stationAt(tt, leg.trainNumber, p.from), to: stationAt(tt, leg.trainNumber, p.to) })),
      }));
      booking.status = bookingStatus(booking.legs);
      booking.history.push({ at: now(), message: `${leg.trainNumber} confirmed after a cancellation: ${leg.berths.map((b) => b.pieces.map((p) => p.berth).join(" → ")).join(", ")}.` });
      promoted.push(booking.pnr);
    }
  }
  return promoted;
}

function stationAt(tt: Timetable, trainNumber: string, index: number): JourneyStation {
  const id = tt.trains.find((t) => t.number === trainNumber)!.stops[index]!.stationId;
  return { id, code: id, name: tt.stationsByCode.get(id)?.name ?? id };
}

/** Test hook. */
export function resetBookings() {
  bookings.clear();
}

export { PlanError };
