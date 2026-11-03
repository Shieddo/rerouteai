// Loads the aligned railway dataset (data/railway/*.csv) into the app's rail model.
// stations.csv + trains.csv + train_stops.csv are the timetable; availability, fares and bookings
// come from inventory.ts / fares.ts, which the dataset's other CSVs were regenerated from.

import { fileURLToPath } from "node:url";
import { createInMemoryRailData, type RailData } from "../rail/repository.ts";
import { WEEKDAYS, type ScheduleTime, type Station, type Train, type TrainStop, type TrainType } from "../rail/types.ts";
import { readCsv, type CsvRow } from "./csv.ts";

export const DATASET_DIR = fileURLToPath(new URL("../../data/railway/", import.meta.url));

export type TrainMeta = {
  number: string;
  name: string;
  demandIndex: number;
  /** stationId -> index in train.stops */
  stopIndex: Map<string, number>;
};

export type Timetable = {
  stations: Station[];
  trains: Train[];
  meta: Map<string, TrainMeta>;
  rail: RailData;
  stationsByCode: Map<string, Station>;
};

/** Best guess at the service type from the name; the source dataset does not record it. */
export function inferTrainType(name: string): TrainType {
  const n = name.toLowerCase();
  if (n.includes("vande")) return "vande-bharat";
  if (n.includes("rajdhani")) return "rajdhani";
  if (n.includes("shatabdi")) return "shatabdi";
  if (n.includes("duronto")) return "duronto";
  if (n.includes("passenger")) return "passenger";
  if (/\b(sf|s f|sup fast|superfast|mail|humsafar|swarna jayanthi)\b/.test(n)) return "superfast";
  return "express";
}

const titleCase = (s: string) => s.replace(/\s+/g, " ").trim();

function time(minutes: number): ScheduleTime {
  const day = Math.floor(minutes / 1440);
  const clock = minutes % 1440;
  return { dayOffset: day, time: `${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}` };
}

export function buildTimetable(stationRows: CsvRow[], trainRows: CsvRow[], stopRows: CsvRow[]): Timetable {
  const stations: Station[] = stationRows.map((r) => ({
    id: r["station_code"]!,
    code: r["station_code"]!,
    name: titleCase(r["station_name"]!),
    city: titleCase(r["city"] || r["station_name"]!),
  }));
  const stationsByCode = new Map(stations.map((s) => [s.id, s]));

  const stopsByTrain = new Map<string, CsvRow[]>();
  for (const row of stopRows) {
    const list = stopsByTrain.get(row["train_id"]!);
    if (list) list.push(row);
    else stopsByTrain.set(row["train_id"]!, [row]);
  }

  const trains: Train[] = [];
  const meta = new Map<string, TrainMeta>();
  for (const row of trainRows) {
    const number = row["train_number"]!;
    const rows = (stopsByTrain.get(row["train_id"]!) ?? []).sort((a, b) => Number(a["stop_sequence"]) - Number(b["stop_sequence"]));
    const last = rows.length - 1;
    const stops: TrainStop[] = rows.map((s, i) => ({
      stationId: s["station_code"]!,
      arrival: i === 0 ? null : time(Number(s["arrival_minutes_from_origin"])),
      departure: i === last ? null : time(Number(s["departure_minutes_from_origin"])),
      distanceKm: Number(s["distance_from_origin_km"]),
    }));
    const name = titleCase(row["train_name"]!);
    trains.push({
      number,
      name,
      type: (row["train_type"] as TrainType) || inferTrainType(name),
      // The source timetable has no operating days; every train is treated as daily.
      runDays: [...WEEKDAYS],
      stops,
    });
    meta.set(number, {
      number,
      name,
      demandIndex: Number(row["demand_index"]) || 1,
      stopIndex: new Map(stops.map((s, i) => [s.stationId, i])),
    });
  }

  return { stations, trains, meta, stationsByCode, rail: createInMemoryRailData({ stations, trains }) };
}

let loaded: Promise<Timetable> | null = null;

/** The dataset timetable, loaded once per process. */
export function loadTimetable(dir = DATASET_DIR): Promise<Timetable> {
  loaded ??= (async () => {
    const [stations, trains, stops] = await Promise.all([
      readCsv(`${dir}stations.csv`),
      readCsv(`${dir}trains.csv`),
      readCsv(`${dir}train_stops.csv`),
    ]);
    return buildTimetable(stations, trains, stops);
  })();
  return loaded;
}

/** RailData facade that loads the dataset on first use, for code that wants a RailData up front. */
export const datasetRailData: RailData = {
  getStation: async (id) => (await loadTimetable()).rail.getStation(id),
  getTrain: async (n) => (await loadTimetable()).rail.getTrain(n),
  listStations: async () => (await loadTimetable()).rail.listStations(),
  listTrains: async () => (await loadTimetable()).rail.listTrains(),
  trainsStoppingAt: async (id) => (await loadTimetable()).rail.trainsStoppingAt(id),
};
