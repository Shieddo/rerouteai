import { DEFAULT_LIMIT, searchStations } from "./searchStations";
import type { Station } from "./types";

/**
 * The only thing the autocomplete knows about where stations come from. An API-backed
 * implementation just has to return the same shape; the UI doesn't change.
 */
export type StationSource = {
  search(query: string, signal?: AbortSignal): Promise<Station[]>;
};

export function createStaticStationSource(stations: readonly Station[], limit = DEFAULT_LIMIT): StationSource {
  return { search: async (query) => searchStations(stations, query, limit) };
}

/** Stations from the backend's railway dataset (public endpoint, so it works before sign-in). */
export const apiStationSource: StationSource = {
  async search(query, signal) {
    if (!query.trim()) return [];
    const res = await fetch(`/stations/search?${new URLSearchParams({ q: query, limit: "8" })}`, { signal });
    if (!res.ok) throw new Error(`Station search failed (${res.status})`);
    const rows = (await res.json()) as { code: string; name: string; city?: string }[];
    return rows.map((r) => ({ id: r.code, code: r.code, name: r.name, city: r.city ?? r.name }));
  },
};
