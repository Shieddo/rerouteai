import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { send, serve } from "../../test/http.ts";
import { createSessionToken } from "../auth/session.ts";
import { userStore } from "../auth/userstore.ts";
import { addDays } from "../rail/time.ts";
import { autoBook, bookOption, cancelBooking, listBookings, refundQuote, resetBookings } from "./bookings.ts";
import { createDatasetRouter } from "./controller.ts";
import { parseCsv, readCsv, stringifyCsv } from "./csv.ts";
import { fareFor, isClassCode, isQuota, refundFor, refundRatio } from "./fares.ts";
import { allocate, getSeatMap, planBerths, release, resetSeatMaps, segmentAvailability } from "./inventory.ts";
import { planTrip, todayIst } from "./planner.ts";
import { DATASET_DIR, loadTimetable } from "./timetable.ts";

beforeEach(() => {
  resetSeatMaps();
  resetBookings();
});

describe("csv", () => {
  test("round-trips quotes, commas, newlines and a BOM", () => {
    const rows = [{ a: 'say "hi"', b: "x,y", c: "line1\nline2" }];
    const text = "﻿" + stringifyCsv(["a", "b", "c"], rows);
    expect(parseCsv(text)).toEqual(rows);
  });
});

describe("fares and refunds", () => {
  test("fares grow with distance and class, tatkal costs more, rounded to ₹5", () => {
    const sl = fareFor("SL", "GN", 500);
    expect(sl % 5).toBe(0);
    expect(fareFor("3A", "GN", 500)).toBeGreaterThan(sl);
    expect(fareFor("2A", "GN", 500)).toBeGreaterThan(fareFor("3A", "GN", 500));
    expect(fareFor("SL", "TQ", 500)).toBeGreaterThan(sl);
    expect(fareFor("SL", "GN", 500, 3)).toBe(sl * 3);
  });

  test("refund curve reproduces the source dataset (35% on the day, +7%/day, max 95%)", () => {
    expect([0, 1, 2, 3, 5, 7, 14, 60].map(refundRatio)).toEqual([0.35, 0.42, 0.49, 0.56, 0.7, 0.84, 0.95, 0.95]);
    expect(refundFor(1000, 3)).toBe(560);
  });
});

describe("aligned dataset", () => {
  test("timetable loads every train and strictly increasing stop times", async () => {
    const tt = await loadTimetable();
    expect(tt.trains.length).toBe(120);
    expect(tt.stations.length).toBe(1391);
    expect(await tt.rail.getStation("NDLS")).toMatchObject({ name: "New Delhi" });
  });

  test("published availability, fares and bookings match what the app computes", async () => {
    const tt = await loadTimetable();
    const availability = await readCsv(`${DATASET_DIR}availability_training.csv`);
    const bookings = await readCsv(`${DATASET_DIR}booking_cancellation_training.csv`);
    expect(bookings.length).toBe(availability.length);

    // A spread-out sample keeps the test fast while covering every train and class.
    for (let i = 0; i < availability.length; i += 997) {
      const a = availability[i]!;
      const b = bookings[i]!;
      const classCode = a["class_code"];
      const quota = a["quota"];
      if (!isClassCode(classCode) || !isQuota(quota)) throw new Error("bad class/quota");
      const train = tt.trains.find((t) => t.number === a["train_number"])!;
      const meta = tt.meta.get(train.number)!;
      const map = getSeatMap({ trainNumber: train.number, originDate: a["train_origin_date"]!, classCode, stopCount: train.stops.length, demandIndex: meta.demandIndex });
      const from = Number(a["from_sequence"]) - 1;
      const boardDay = train.stops[from]!.departure!.dayOffset;
      const result = segmentAvailability(map, { from, to: Number(a["to_sequence"]) - 1, daysBefore: Number(a["days_to_departure"]) - boardDay, quota, passengers: Number(a["passengers"]) });

      expect(a["availability_status"]).toBe(result.status);
      expect(Number(a["seats_available"])).toBe(result.seatsAvailable);
      expect(a["confirmed_by_chart"]).toBe(String(result.confirmedByChart));
      expect(Number(a["total_fare_inr"])).toBe(fareFor(classCode, quota, Number(a["distance_km"]), Number(a["passengers"])));
      // Booking file agrees with the availability file row for row.
      expect(b["snapshot_id"]).toBe(a["snapshot_id"]!);
      expect(b["quoted_fare_inr"]).toBe(a["total_fare_inr"]!);
      expect(b["booking_result"] === "FAILED").toBe(a["availability_status"] === "CLOSED");
      if (b["cancelled"] === "true") expect(Number(b["days_before_departure_cancelled"])).toBeLessThanOrEqual(Number(b["days_to_departure"]));
    }
  });
});

describe("berth inventory", () => {
  const run = { trainNumber: "11058", originDate: "2027-01-10", classCode: "SL" as const, stopCount: 84, demandIndex: 1 };

  test("is deterministic", () => {
    const a = segmentAvailability(getSeatMap(run), { from: 0, to: 40, daysBefore: 10, quota: "GN", passengers: 1 });
    resetSeatMaps();
    expect(segmentAvailability(getSeatMap(run), { from: 0, to: 40, daysBefore: 10, quota: "GN", passengers: 1 })).toEqual(a);
  });

  test("a train only fills up as departure approaches (without cancellations it never empties)", () => {
    const map = getSeatMap(run);
    const seats = [120, 60, 30, 14, 7, 1].map((d) => segmentAvailability(map, { from: 5, to: 20, daysBefore: d, quota: "GN", passengers: 1 }).seatsAvailable);
    expect(seats[0]).toBeGreaterThan(seats[seats.length - 1]!);
  });

  test("tatkal is closed until one day before", () => {
    const map = getSeatMap(run);
    expect(segmentAvailability(map, { from: 0, to: 10, daysBefore: 5, quota: "TQ", passengers: 1 })).toMatchObject({ status: "CLOSED", closedReason: "TATKAL_NOT_OPEN" });
  });

  test("berth-change plans cover the ride exactly and never double-book a berth", () => {
    const map = getSeatMap(run);
    for (let from = 0; from < 70; from += 7) {
      const plans = planBerths(map, { from, to: from + 13, daysBefore: 3, quota: "GN", passengers: 3, maxChanges: 3 });
      if (!plans) continue;
      const used: { berth: number; from: number; to: number }[] = [];
      for (const plan of plans) {
        expect(plan[0]!.from).toBe(from);
        expect(plan[plan.length - 1]!.to).toBe(from + 13);
        plan.forEach((p, i) => {
          if (i > 0) expect(p.from).toBe(plan[i - 1]!.to);
          for (const u of used) if (u.berth === p.berth.index) expect(u.to <= p.from || u.from >= p.to).toBe(true);
          used.push({ berth: p.berth.index, from: p.from, to: p.to });
        });
      }
    }
  });

  test("allocating takes seats away and releasing gives them back", () => {
    const map = getSeatMap(run);
    const q = { from: 2, to: 9, daysBefore: 60, quota: "GN" as const, passengers: 2 };
    const before = segmentAvailability(map, q).seatsAvailable;
    const plans = planBerths(map, q)!;
    allocate(map, "PNR1", plans);
    expect(segmentAvailability(map, q).seatsAvailable).toBe(before - 2);
    release(map, "PNR1");
    expect(segmentAvailability(map, q).seatsAvailable).toBe(before);
  });
});

describe("planner and bookings", () => {
  const date = () => addDays(todayIst(), 40);

  test("plans priced, ranked options with guaranteed seats first", async () => {
    const plan = await planTrip({ from: "NDLS", to: "CSMT", date: date(), classCode: "3A", passengers: 2 }, "u1");
    expect(plan.options.length).toBeGreaterThan(0);
    const firstUnguaranteed = plan.options.findIndex((o) => !o.guaranteed);
    if (firstUnguaranteed >= 0) expect(plan.options.slice(firstUnguaranteed).every((o) => !o.guaranteed)).toBe(true);
    for (const o of plan.options) expect(o.totalFare).toBe(o.legs.reduce((n, l) => n + l.fare, 0));
    expect(plan.classComparison.map((c) => c.classCode)).toEqual(["SL", "3A", "2A", "CC"]);
  });

  test("rejects unknown stations and past dates", async () => {
    await expect(planTrip({ from: "ZZZZZ", to: "CSMT", date: date(), classCode: "SL", passengers: 1 })).rejects.toThrow("Unknown station");
    await expect(planTrip({ from: "NDLS", to: "CSMT", date: "2020-01-01", classCode: "SL", passengers: 1 })).rejects.toThrow("today or later");
  });

  test("book, quote refund, cancel; options are private to whoever searched", async () => {
    const plan = await planTrip({ from: "NDLS", to: "CSMT", date: date(), classCode: "3A", passengers: 1 }, "alice");
    const option = plan.options.find((o) => o.guaranteed)!;
    await expect(bookOption("mallory", option.id)).rejects.toThrow("expired or does not exist");

    const booking = await bookOption("alice", option.id);
    expect(booking.pnr).toMatch(/^\d{10}$/);
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.legs.every((l) => l.berths.length === 1)).toBe(true);
    expect(listBookings("alice")).toHaveLength(1);
    expect(listBookings("mallory")).toHaveLength(0);

    const quote = refundQuote(booking)!;
    expect(quote.amount).toBe(refundFor(booking.totalFare, quote.daysBefore));
    await expect(cancelBooking("mallory", booking.pnr)).rejects.toThrow("No booking");
    const { booking: cancelled } = await cancelBooking("alice", booking.pnr);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.refund?.amount).toBe(quote.amount);
    await expect(cancelBooking("alice", booking.pnr)).rejects.toThrow("already cancelled");
  });

  test("auto-book respects the fare limit", async () => {
    const result = await autoBook("bob", { from: "NDLS", to: "CSMT", date: date(), classCode: "SL", passengers: 1, maxFare: 1 });
    expect(result.booking).toBeNull();
    expect(result.attempts.every((a) => a.outcome.startsWith("skipped"))).toBe(true);
  });
});

describe("HTTP API", () => {
  let base: string;
  let close: () => void;
  let auth: Record<string, string>;
  const realGroq = process.env["GROQ_API_KEY"];

  beforeAll(async () => {
    process.env["SESSION_SECRET"] ??= "test-secret";
    const user = await userStore.create({ email: "d@example.com", name: "D", provider: "github", providerId: "dataset-test" });
    auth = { Authorization: `Bearer ${createSessionToken(user.id)}` };
    const app = express();
    app.use(express.json());
    app.use(createDatasetRouter());
    ({ base, close } = await serve(app));
  });
  afterAll(() => {
    close();
    if (realGroq === undefined) delete process.env["GROQ_API_KEY"];
    else process.env["GROQ_API_KEY"] = realGroq;
  });

  test("requires sign-in", async () => {
    expect((await send(base, "/plan?from=NDLS&to=CSMT&date=2030-01-01")).status).toBe(401);
    expect((await send(base, "/bookings")).status).toBe(401);
  });

  test("validates plan input", async () => {
    expect((await send(base, "/plan?from=NDLS&to=NDLS&date=2030-01-01", { headers: auth })).status).toBe(400);
    expect((await send(base, `/plan?from=NDLS&to=CSMT&date=${addDays(todayIst(), 5)}&class=1A`, { headers: auth })).status).toBe(400);
    expect((await send(base, `/plan?from=NDLS&to=CSMT&date=${addDays(todayIst(), 5)}&passengers=9`, { headers: auth })).status).toBe(400);
  });

  test("plan then book over HTTP", async () => {
    const plan = await send(base, `/plan?from=NDLS&to=CSMT&date=${addDays(todayIst(), 40)}&class=3A`, { headers: auth });
    expect(plan.status).toBe(200);
    const option = (JSON.parse(plan.body) as { options: { id: string; guaranteed: boolean }[] }).options.find((o) => o.guaranteed)!;
    const booked = await send(base, "/bookings", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ optionId: option.id }) });
    expect(booked.status).toBe(201);
    const { booking } = JSON.parse(booked.body) as { booking: { pnr: string } };
    expect((await send(base, `/bookings/${booking.pnr}/refund`, { headers: auth })).status).toBe(200);
    expect((await send(base, `/bookings/${booking.pnr}/cancel`, { method: "POST", headers: auth })).status).toBe(200);
  });

  test("chat answers 503 when the assistant is not configured", async () => {
    delete process.env["GROQ_API_KEY"];
    const r = await send(base, "/chat", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    expect(r.status).toBe(503);
  });
});

