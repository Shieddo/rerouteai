// Station lookup over the dataset's stations (the app's primary station directory).

import { loadTimetable } from "./timetable.ts";

export type StationMatch = { code: string; name: string; city: string; trains: number };

/** Lower is better: exact code, code prefix, name prefix, word prefix, substring. */
function rank(code: string, name: string, q: string): number {
  const c = code.toLowerCase();
  const n = name.toLowerCase();
  if (c === q) return 0;
  if (n === q) return 1;
  if (c.startsWith(q)) return 2;
  if (n.startsWith(q)) return 3;
  if (n.split(/[\s-]+/).some((w) => w.startsWith(q))) return 4;
  if (n.includes(q)) return 5;
  return Infinity;
}

export async function searchDatasetStations(query: string, limit = 8): Promise<StationMatch[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tt = await loadTimetable();
  const served = new Map<string, number>();
  for (const t of tt.trains) for (const s of t.stops) served.set(s.stationId, (served.get(s.stationId) ?? 0) + 1);

  return tt.stations
    .map((s) => ({ s, score: rank(s.id, s.name, q), trains: served.get(s.id) ?? 0 }))
    .filter((m) => m.score !== Infinity && m.trains > 0)
    // Busier stations first within a rank: "delhi" should offer New Delhi before a halt.
    .sort((a, b) => a.score - b.score || b.trains - a.trains || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map(({ s, trains }) => ({ code: s.id, name: s.name, city: s.city, trains }));
}

export async function isDatasetStation(code: string): Promise<boolean> {
  return (await loadTimetable()).stationsByCode.has(code);
}
