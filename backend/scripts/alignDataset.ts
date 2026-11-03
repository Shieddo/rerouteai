// Regenerates the whole railway dataset so every file agrees with every other and with the app.
//
//   bun scripts/alignDataset.ts [sourceDir] [outDir]
//   defaults: data/source -> data/railway
//
// What it does:
//  - stations.csv: sorted by code, `city` added.
//  - train_stops.csv: stops kept in sequence. Trains whose every stop carries the origin's timestamp
//    (no timing at all in the source) are rebuilt from distance at the network's average speed
//    plus 5-minute halts, flagged timetable_reconstructed; any other consecutive stops sharing a
//    timestamp get a 1-minute gap; day columns are recomputed from minutes.
//  - trains.csv: inferred train_type, `daily (assumed)` service days, and a demand_index derived
//    from how full each train was in the original availability data.
//  - availability_training.csv: every status, seat count, RAC/WL position, chart confirmation and
//    fare recomputed from the berth simulator (src/dataset/inventory.ts) and fare rules
//    (src/dataset/fares.ts); distances/durations recomputed from the timetable.
//  - booking_cancellation_training.csv: one row per availability row, same fare and status; booking
//    result follows the status; cancellations happen after booking; refunds use the refund rule.
//  - route_options_training.csv: times, waits, distances and fares recomputed from the timetable;
//    feasibility uses the app's transfer rules; confirmation from the berth simulator.

import { mkdir } from "node:fs/promises";
import { readCsv, stringifyCsv, type CsvRow } from "../src/dataset/csv.ts";
import {
  CLASSES,
  fareFor,
  isClassCode,
  isQuota,
  REFUND_RULE,
  refundFor,
  WAITLIST_REFUND_RULE,
  waitlistRefund,
  type ClassCode,
  type Quota,
} from "../src/dataset/fares.ts";
import { getSeatMap, isPeakSeason, isWeekend, segmentAvailability } from "../src/dataset/inventory.ts";
import { buildTimetable, inferTrainType } from "../src/dataset/timetable.ts";
import { addDays, weekdayOf } from "../src/rail/time.ts";

const SRC = (process.argv[2] ?? "data/source").replace(/\/?$/, "/");
const OUT = (process.argv[3] ?? "data/railway").replace(/\/?$/, "/");
const TRANSFER_BUFFER = 30;
const MAX_TRANSFER_WAIT = 12 * 60;
const ROUTE_OPTION_DAYS_BEFORE = 14;
const WEEKDAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function write(name: string, columns: string[], rows: Record<string, unknown>[]) {
  await Bun.write(`${OUT}${name}`, stringifyCsv(columns, rows));
  console.log(`  ${name}: ${rows.length} rows`);
}

const raw = {
  stations: await readCsv(`${SRC}stations.csv`),
  trains: await readCsv(`${SRC}trains.csv`),
  stops: await readCsv(`${SRC}train_stops.csv`),
  availability: await readCsv(`${SRC}availability_training.csv`),
  bookings: await readCsv(`${SRC}booking_cancellation_training.csv`),
  routes: await readCsv(`${SRC}route_options_training.csv`),
};
await mkdir(OUT, { recursive: true });
console.log(`Aligning ${SRC} -> ${OUT}`);

// ---- stations -----------------------------------------------------------------------------
const stations = raw.stations
  .map((s): CsvRow => ({ ...s, station_name: s["station_name"]!.trim(), city: s["station_name"]!.trim() }))
  .sort((a, b) => a["station_code"]!.localeCompare(b["station_code"]!));
await write("stations.csv", ["station_code", "station_name", "city", "state", "zone", "latitude", "longitude", "station_name_source", "is_real_station"], stations);

// ---- train stops --------------------------------------------------------------------------
const stopsByTrain = new Map<string, CsvRow[]>();
for (const s of raw.stops) {
  const list = stopsByTrain.get(s["train_id"]!) ?? [];
  list.push(s);
  stopsByTrain.set(s["train_id"]!, list);
}
let tiesFixed = 0;
const reconstructed = new Set<string>();
const stops: CsvRow[] = [];
// Average running speed of the healthy timetables, used to rebuild the flat ones.
let healthyKm = 0;
let healthyMinutes = 0;
for (const rows of stopsByTrain.values()) {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const minutes = Number(last["arrival_minutes_from_origin"]) - Number(first["departure_minutes_from_origin"]);
  if (minutes > 60) {
    healthyKm += Number(last["distance_from_origin_km"]);
    healthyMinutes += minutes;
  }
}
const kmPerMinute = healthyKm / healthyMinutes;
const HALT_MINUTES = 5;
console.log(`  average scheduled speed ${(kmPerMinute * 60).toFixed(1)} km/h`);

for (const t of raw.trains) {
  const rows = (stopsByTrain.get(t["train_id"]!) ?? []).sort((a, b) => Number(a["stop_sequence"]) - Number(b["stop_sequence"]));
  // A timetable where (nearly) every stop shares the origin's timestamp carries no timing at all:
  // rebuild it from distances, keeping the real origin departure.
  const flat = rows.slice(1).filter((s) => Number(s["arrival_minutes_from_origin"]) <= Number(rows[0]!["departure_minutes_from_origin"])).length >= (rows.length - 1) * 0.8;
  if (flat) reconstructed.add(t["train_id"]!);
  let previousDeparture = -1;
  let previousKm = 0;
  rows.forEach((s, i) => {
    let arrival = Number(s["arrival_minutes_from_origin"]);
    let departure = Number(s["departure_minutes_from_origin"]);
    const km = Number(s["distance_from_origin_km"]);
    if (flat && i > 0) {
      arrival = previousDeparture + Math.max(2, Math.round((km - previousKm) / kmPerMinute));
      departure = i === rows.length - 1 ? arrival : arrival + HALT_MINUTES;
    } else if (i > 0 && arrival <= previousDeparture) {
      arrival = previousDeparture + 1;
      tiesFixed++;
    }
    departure = Math.max(departure, arrival);
    previousDeparture = departure;
    previousKm = km;
    stops.push({
      ...s,
      stop_sequence: String(i + 1),
      arrival_time: hhmm(arrival),
      departure_time: hhmm(departure),
      arrival_day: String(Math.floor(arrival / 1440) + 1),
      departure_day: String(Math.floor(departure / 1440) + 1),
      arrival_minutes_from_origin: String(arrival),
      departure_minutes_from_origin: String(departure),
      timetable_reconstructed: String(flat),
    });
  });
}
console.log(`  rebuilt ${reconstructed.size} timetables with no timings (${[...reconstructed].join(", ")}) from distance`);
console.log(`  fixed ${tiesFixed} stops that shared a timestamp with the previous stop`);
await write(
  "train_stops.csv",
  ["train_id", "stop_sequence", "station_code", "station_name", "arrival_time", "departure_time", "arrival_day", "departure_day", "arrival_minutes_from_origin", "departure_minutes_from_origin", "distance_from_origin_km", "timetable_reconstructed", "schedule_snapshot", "is_synthetic_record"],
  stops,
);

// ---- trains -------------------------------------------------------------------------------
// demand_index: how often each train was not AVAILABLE in the source data, relative to all trains.
const notAvailable = new Map<string, { busy: number; total: number }>();
let busyAll = 0;
for (const a of raw.availability) {
  const e = notAvailable.get(a["train_id"]!) ?? { busy: 0, total: 0 };
  const busy = a["availability_status"] !== "AVAILABLE" ? 1 : 0;
  e.busy += busy;
  e.total++;
  busyAll += busy;
  notAvailable.set(a["train_id"]!, e);
}
const busyShare = busyAll / raw.availability.length;
const trains = raw.trains.map((t): CsvRow => {
  const e = notAvailable.get(t["train_id"]!);
  const ratio = e ? e.busy / e.total / busyShare : 1;
  const demandIndex = Math.min(1.15, Math.max(0.85, 1 + (ratio - 1) * 3));
  return {
    ...t,
    train_name: t["train_name"]!.replace(/\s+/g, " ").trim(),
    train_type: inferTrainType(t["train_name"]!),
    service_days: "daily (assumed)",
    service_days_verified: "false",
    classes: CLASSES.join(" "),
    demand_index: demandIndex.toFixed(3),
    timetable_reconstructed: String(reconstructed.has(t["train_id"]!)),
  };
});
await write(
  "trains.csv",
  ["train_id", "train_number", "train_name", "train_type", "source_station_code", "source_station_name", "destination_station_code", "destination_station_name", "stop_count", "service_days", "service_days_verified", "classes", "demand_index", "timetable_reconstructed", "schedule_snapshot", "timetable_is_reference_data", "is_synthetic_record"],
  trains,
);

// ---- timetable model (same code the app runs) ----------------------------------------------
const tt = buildTimetable(stations, trains, stops);
const stopByKey = new Map(stops.map((s) => [`${s["train_id"]}|${s["station_code"]}`, s]));
const trainByNumber = new Map(tt.trains.map((t) => [t.number, t]));
const trainById = new Map(raw.trains.map((t) => [t["train_id"]!, t["train_number"]!]));

function segment(trainId: string, from: string, to: string) {
  const number = trainById.get(trainId)!;
  const train = trainByNumber.get(number)!;
  const meta = tt.meta.get(number)!;
  const i = meta.stopIndex.get(from);
  const j = meta.stopIndex.get(to);
  if (i === undefined || j === undefined || j <= i) return null;
  const dep = stopByKey.get(`${trainId}|${from}`)!;
  const arr = stopByKey.get(`${trainId}|${to}`)!;
  const depMin = Number(dep["departure_minutes_from_origin"]);
  const arrMin = Number(arr["arrival_minutes_from_origin"]);
  return {
    number,
    train,
    meta,
    from: i,
    to: j,
    depMin,
    arrMin,
    boardDayOffset: Math.floor(depMin / 1440),
    distanceKm: Math.round(train.stops[j]!.distanceKm - train.stops[i]!.distanceKm),
    durationMinutes: arrMin - depMin,
  };
}
type Segment = NonNullable<ReturnType<typeof segment>>;
const segmentCache = new Map<string, Segment | null>();
const seg = (trainId: string, from: string, to: string) => {
  const k = `${trainId}|${from}|${to}`;
  if (!segmentCache.has(k)) segmentCache.set(k, segment(trainId, from, to));
  return segmentCache.get(k)!;
};

function availabilityFor(s: Segment, travelDate: string, daysToDeparture: number, classCode: ClassCode, quota: Quota, passengers: number) {
  const originDate = addDays(travelDate, -s.boardDayOffset);
  const map = getSeatMap({ trainNumber: s.number, originDate, classCode, stopCount: s.train.stops.length, demandIndex: s.meta.demandIndex });
  return {
    originDate,
    result: segmentAvailability(map, { from: s.from, to: s.to, daysBefore: daysToDeparture - s.boardDayOffset, quota, passengers }),
  };
}

// ---- availability + booking/cancellation ---------------------------------------------------
const availability: Record<string, unknown>[] = [];
const bookings: Record<string, unknown>[] = [];
let skipped = 0;
raw.availability.forEach((a, idx) => {
  const s = seg(a["train_id"]!, a["from_station"]!, a["to_station"]!);
  const classCode = a["class_code"];
  const quota = a["quota"];
  if (!s || !isClassCode(classCode) || !isQuota(quota)) {
    skipped++;
    return;
  }
  const travelDate = a["travel_date"]!;
  const dtd = Number(a["days_to_departure"]);
  const passengers = Number(a["passengers"]) || 1;
  const { originDate, result } = availabilityFor(s, travelDate, dtd, classCode, quota, passengers);
  const fare = fareFor(classCode, quota, s.distanceKm, passengers);

  availability.push({
    snapshot_id: a["snapshot_id"],
    observed_at: `${addDays(travelDate, -dtd)}T18:00:00+05:30`,
    travel_date: travelDate,
    train_origin_date: originDate,
    days_to_departure: dtd,
    train_id: a["train_id"],
    train_number: s.number,
    train_name: s.meta.name,
    from_station: a["from_station"],
    to_station: a["to_station"],
    from_sequence: s.from + 1,
    to_sequence: s.to + 1,
    class_code: classCode,
    quota,
    distance_km: s.distanceKm,
    duration_minutes: s.durationMinutes,
    weekday: WEEKDAY_NAMES[weekdayOf(travelDate)],
    is_weekend: isWeekend(travelDate),
    is_peak_season: isPeakSeason(travelDate),
    passengers,
    availability_status: result.status,
    seats_available: result.seatsAvailable,
    rac_position: result.racPosition ?? "",
    waitlist_position: result.waitlistPosition ?? "",
    closed_reason: result.closedReason ?? "",
    confirm_chance: result.confirmChance,
    confirmed_by_chart: result.confirmedByChart,
    total_fare_inr: fare,
    availability_is_synthetic: true,
    timetable_snapshot: a["timetable_snapshot"],
  });

  // Booking outcome follows availability; cancellations can only happen after booking.
  const b = raw.bookings[idx];
  const bookingResult =
    result.status === "AVAILABLE" ? "CONFIRMED" : result.status === "RAC" ? "RAC" : result.status === "WAITLIST" ? "WAITLISTED" : "FAILED";
  const booked = bookingResult !== "FAILED";
  const userCancelled = booked && b?.["cancelled"] === "true";
  const cancelDays = userCancelled ? Math.min(Number(b!["days_before_departure_cancelled"]) || 0, dtd) : null;
  let refund: number | "" = "";
  let rule = "";
  let chartStatus = "";
  if (booked && userCancelled) {
    refund = refundFor(fare, cancelDays!);
    rule = REFUND_RULE;
    chartStatus = "CANCELLED_BY_PASSENGER";
  } else if (booked && !result.confirmedByChart && result.status === "RAC") {
    chartStatus = "RAC_SHARED_BERTH";
  } else if (booked && !result.confirmedByChart) {
    refund = waitlistRefund(fare, passengers);
    rule = WAITLIST_REFUND_RULE;
    chartStatus = "NOT_CONFIRMED_AUTO_CANCELLED";
  } else if (booked) chartStatus = "CONFIRMED";

  bookings.push({
    record_id: b?.["record_id"] ?? `BC${String(idx + 1).padStart(7, "0")}`,
    snapshot_id: a["snapshot_id"],
    travel_date: travelDate,
    train_id: a["train_id"],
    train_number: s.number,
    train_name: s.meta.name,
    from_station: a["from_station"],
    to_station: a["to_station"],
    class_code: classCode,
    quota,
    passengers,
    days_to_departure: dtd,
    quoted_fare_inr: fare,
    availability_status: result.status,
    booking_result: bookingResult,
    chart_status: chartStatus,
    cancelled: userCancelled,
    days_before_departure_cancelled: cancelDays ?? "",
    refund_amount_inr: refund,
    refund_rule: rule,
    outcome_is_synthetic: true,
    timetable_snapshot: a["timetable_snapshot"],
  });
});
if (skipped) console.log(`  skipped ${skipped} availability rows whose segment is not on the train`);
await write(
  "availability_training.csv",
  Object.keys(availability[0]!),
  availability,
);
await write("booking_cancellation_training.csv", Object.keys(bookings[0]!), bookings);

// ---- route options ------------------------------------------------------------------------
const routes: Record<string, unknown>[] = [];
let droppedRoutes = 0;
for (const r of raw.routes) {
  const classCode = r["class_code"];
  if (!isClassCode(classCode)) {
    droppedRoutes++;
    continue;
  }
  const travelDate = r["travel_date"]!;
  const twoLeg = r["leg_count"] === "2";
  const leg1 = seg(r["leg1_train_id"]!, r["origin_station"]!, twoLeg ? r["transfer_station"]! : r["destination_station"]!);
  const leg2 = twoLeg ? seg(r["leg2_train_id"]!, r["transfer_station"]!, r["destination_station"]!) : null;
  if (!leg1 || (twoLeg && !leg2)) {
    droppedRoutes++;
    continue;
  }
  // Minutes since 00:00 on the travel (boarding) date.
  const offset1 = leg1.boardDayOffset * 1440;
  const dep1 = leg1.depMin - offset1;
  const arr1 = leg1.arrMin - offset1;
  let arrival = arr1;
  let wait: number | "" = "";
  let feasible = true;
  let confirmed = availabilityFor(leg1, travelDate, ROUTE_OPTION_DAYS_BEFORE, classCode, "GN", 1).result.confirmedByChart;
  let fare = fareFor(classCode, "GN", leg1.distanceKm);
  let distance = leg1.distanceKm;
  if (leg2) {
    // Daily trains: take the first run of leg 2 that leaves at least the buffer after arrival.
    const earliest = arr1 + TRANSFER_BUFFER;
    const k = Math.ceil((earliest - leg2.depMin) / 1440);
    const dep2 = leg2.depMin + k * 1440;
    wait = dep2 - arr1;
    feasible = wait <= MAX_TRANSFER_WAIT;
    arrival = dep2 + leg2.durationMinutes;
    const leg2BoardDate = addDays(travelDate, Math.floor(dep2 / 1440));
    confirmed &&= availabilityFor(leg2, leg2BoardDate, ROUTE_OPTION_DAYS_BEFORE + Math.floor(dep2 / 1440), classCode, "GN", 1).result.confirmedByChart;
    fare += fareFor(classCode, "GN", leg2.distanceKm);
    distance += leg2.distanceKm;
  }
  routes.push({
    option_id: r["option_id"],
    request_id: r["request_id"],
    travel_date: travelDate,
    days_to_departure: ROUTE_OPTION_DAYS_BEFORE,
    origin_station: r["origin_station"],
    destination_station: r["destination_station"],
    class_code: classCode,
    leg_count: twoLeg ? 2 : 1,
    leg1_train_id: r["leg1_train_id"],
    leg1_train_name: leg1.meta.name,
    transfer_station: twoLeg ? r["transfer_station"] : "",
    leg2_train_id: twoLeg ? r["leg2_train_id"] : "",
    leg2_train_name: leg2 ? leg2.meta.name : "",
    scheduled_departure_minutes: dep1,
    scheduled_arrival_minutes: arrival,
    transfer_wait_minutes: wait,
    total_duration_minutes: arrival - dep1,
    total_distance_km: distance,
    total_fare_inr: round2(fare),
    connection_feasible: feasible,
    all_legs_confirmed_by_chart: confirmed,
    service_days_verified: false,
    timetable_snapshot: r["timetable_snapshot"],
    outcomes_are_synthetic: true,
  });
}
if (droppedRoutes) console.log(`  dropped ${droppedRoutes} route options whose legs do not match the timetable`);
await write("route_options_training.csv", Object.keys(routes[0]!), routes);

// ---- summary ------------------------------------------------------------------------------
const share = (rows: Record<string, unknown>[], pred: (r: Record<string, unknown>) => boolean) =>
  `${Math.round((rows.filter(pred).length / rows.length) * 100)}%`;
for (const d of [30, 14, 7, 1]) {
  const gn = availability.filter((a) => a["days_to_departure"] === d && a["quota"] === "GN");
  console.log(
    `  GN ${String(d).padStart(2)}d: AVAILABLE ${share(gn, (a) => a["availability_status"] === "AVAILABLE")}, RAC ${share(gn, (a) => a["availability_status"] === "RAC")}, WL ${share(gn, (a) => a["availability_status"] === "WAITLIST")}, CLOSED ${share(gn, (a) => a["availability_status"] === "CLOSED")}, confirmed ${share(gn, (a) => a["confirmed_by_chart"] === true)}`,
  );
}
