// Browser client for the backend API. Like the old vanilla client it never throws: every outcome,
// including network failures, comes back as a value the UI can show.

import type { AlternativeSearchResult, Booking, ChatReply, ClassCode, Journey, PlanResult, Preference, RefundQuote, SavedJourney } from "./types";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (url, init) => fetch(url, init);

async function message(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

const NETWORK = { kind: "error", message: "Network error, please try again." } as const;

// ---- Alternative journeys -----------------------------------------------------------------

export type AlternativesQuery = { from: string; to: string; date: string; time: string; maxTransfers?: number };

export type AlternativesOutcome =
  | { kind: "ok"; result: AlternativeSearchResult }
  | { kind: "unauthorized" }
  /** HTTP 400: the server's message is safe to show. */
  | { kind: "invalid"; message: string }
  /** HTTP 503: timetable data is unavailable; retrying later may help. */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

export function alternativesUrl({ from, to, date, time, maxTransfers }: AlternativesQuery): string {
  const params = new URLSearchParams({ from, to, date, time });
  if (maxTransfers !== undefined) params.set("maxTransfers", String(maxTransfers));
  return `/trains/alternatives?${params}`;
}

export async function fetchAlternatives(query: AlternativesQuery, fetchImpl: Fetch = defaultFetch): Promise<AlternativesOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(alternativesUrl(query));
  } catch {
    return NETWORK;
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 400) return { kind: "invalid", message: await message(res, "Invalid search.") };
  if (res.status === 503) return { kind: "unavailable", message: await message(res, "Timetable data is temporarily unavailable.") };
  if (!res.ok) return { kind: "error", message: await message(res, "Search failed.") };
  try {
    return { kind: "ok", result: (await res.json()) as AlternativeSearchResult };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

// ---- Direct trains ------------------------------------------------------------------------

export type TrainRow = {
  train: { number: string; name: string; runDays: string[] };
  from: { departure: string };
  to: { arrival: string };
  duration: number;
};
export type TrainsResponse = { from: { name: string }; to: { name: string }; trains: TrainRow[] };

export type TrainsOutcome =
  | { kind: "ok"; data: TrainsResponse }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export async function fetchTrains(query: { from: string; to: string; date: string }, fetchImpl: Fetch = defaultFetch): Promise<TrainsOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/trains/search?${new URLSearchParams(query)}`);
  } catch {
    return NETWORK;
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (!res.ok) return { kind: "error", message: await message(res, "Search failed.") };
  try {
    return { kind: "ok", data: (await res.json()) as TrainsResponse };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

// ---- Saved journeys -----------------------------------------------------------------------

export type Failure =
  | { kind: "unauthorized" }
  /** HTTP 400/409/404: the server's message is safe to show. */
  | { kind: "rejected"; status: number; message: string }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string };

export type SaveOutcome = { kind: "saved"; saved: SavedJourney; alreadySaved: boolean } | Failure;
export type ListOutcome = { kind: "ok"; journeys: SavedJourney[] } | Failure;
export type DeleteOutcome = { kind: "deleted" } | Failure;

async function failure(res: Response, fallback: string): Promise<Failure> {
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 429) return { kind: "rate-limited" };
  if (res.status === 400 || res.status === 404 || res.status === 409) {
    return { kind: "rejected", status: res.status, message: await message(res, fallback) };
  }
  return { kind: "error", message: fallback };
}

/** Plain-language text for any failure; the UI decides separately what to do about `unauthorized`. */
export function describeFailure(outcome: { kind: string; message?: string }): string {
  switch (outcome.kind) {
    case "unauthorized":
      return "Please sign in to continue.";
    case "rate-limited":
      return "You're going a bit fast. Wait a moment and try again.";
    default:
      return outcome.message ?? "Something went wrong. Please try again.";
  }
}

export async function saveJourney(journey: Journey, fetchImpl: Fetch = defaultFetch): Promise<SaveOutcome> {
  let res: Response;
  try {
    // Same-origin through the Next proxy: the browser adds the session cookie and the Origin header the CSRF check needs.
    res = await fetchImpl("/journeys/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journey }),
    });
  } catch {
    return NETWORK;
  }
  if (res.status !== 200 && res.status !== 201) return failure(res, "Couldn't save this journey. Please try again.");
  try {
    const body = (await res.json()) as { journey: SavedJourney };
    return { kind: "saved", saved: body.journey, alreadySaved: res.status === 200 };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

export async function listSavedJourneys(fetchImpl: Fetch = defaultFetch): Promise<ListOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/journeys/saved");
  } catch {
    return NETWORK;
  }
  if (!res.ok) return failure(res, "Couldn't load your saved journeys. Please try again.");
  try {
    const body = (await res.json()) as { journeys: SavedJourney[] };
    return { kind: "ok", journeys: body.journeys };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

export async function deleteSavedJourney(id: string, fetchImpl: Fetch = defaultFetch): Promise<DeleteOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/journeys/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    return NETWORK;
  }
  // 404 means it is already gone (maybe removed in another tab): the list should simply drop it.
  if (res.status === 204 || res.status === 404) return { kind: "deleted" };
  return failure(res, "Couldn't remove this journey. Please try again.");
}

// ---- Session ------------------------------------------------------------------------------

export type Profile = { id: string; email?: string; name?: string; provider: string };

/** The signed-in user, or null when signed out or the check fails. */
export async function fetchProfile(fetchImpl: Fetch = defaultFetch): Promise<Profile | null> {
  try {
    const res = await fetchImpl("/me");
    return res.ok ? ((await res.json()) as Profile) : null;
  } catch {
    return null;
  }
}

export type PasswordAuthOutcome = { kind: "ok"; profile: Profile } | { kind: "error"; message: string };

/** Email + password sign-in or sign-up. On success the session cookie is set by the response. */
export async function passwordAuth(
  mode: "signin" | "signup",
  body: { email: string; password: string; name?: string },
  fetchImpl: Fetch = defaultFetch,
): Promise<PasswordAuthOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/auth/password/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return NETWORK;
  }
  if (res.ok) {
    try {
      return { kind: "ok", profile: (await res.json()) as Profile };
    } catch {
      return { kind: "error", message: "Unexpected response from the server." };
    }
  }
  if (res.status === 429) return { kind: "error", message: "Too many attempts. Wait a few minutes and try again." };
  return { kind: "error", message: await message(res, mode === "signin" ? "Couldn't sign you in." : "Couldn't create your account.") };
}

export async function signOut(fetchImpl: Fetch = defaultFetch): Promise<void> {
  try {
    await fetchImpl("/auth/signout", { method: "POST" });
  } catch {
    /* the cookie may still be set; the next profile check will say so */
  }
}

// ---- Planner, bookings and assistant ------------------------------------------------------

export type Outcome<T> = { kind: "ok"; data: T } | Failure;

async function call<T>(url: string, init: RequestInit | undefined, fallback: string, fetchImpl: Fetch): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return NETWORK;
  }
  if (!res.ok) {
    const f = await failure(res, fallback);
    // 502/503/504 carry a safe, user-facing message from the API (e.g. the assistant is busy).
    if (f.kind === "error" && res.status >= 500) return { kind: "error", message: await message(res, fallback) };
    return f;
  }
  try {
    return { kind: "ok", data: (await res.json()) as T };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export type PlanQuery = {
  from: string;
  to: string;
  date: string;
  class: ClassCode;
  passengers: number;
  preference?: Preference;
  berth?: string;
  flexibleDays?: number;
  maxTransfers?: number;
};

const planParams = (q: PlanQuery) =>
  new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));

export const fetchPlan = (q: PlanQuery, f: Fetch = defaultFetch) => call<PlanResult>(`/plan?${planParams(q)}`, undefined, "Search failed.", f);

export const bookOption = (optionId: string, f: Fetch = defaultFetch) =>
  call<{ booking: Booking }>("/bookings", json({ optionId }), "Booking failed. Please try again.", f);

export type AutoBookResult = { booking: Booking | null; attempts: { option: string; outcome: string }[]; message: string };
export const autoBook = (q: PlanQuery & { maxFare?: number; requireConfirmed?: boolean; allowBerthChange?: boolean }, f: Fetch = defaultFetch) =>
  call<AutoBookResult>("/bookings/auto", json(q), "Auto-booking failed. Please try again.", f);

export const listBookings = (f: Fetch = defaultFetch) => call<{ bookings: Booking[] }>("/bookings", undefined, "Couldn't load your bookings.", f);

export const fetchRefundQuote = (pnr: string, f: Fetch = defaultFetch) =>
  call<RefundQuote>(`/bookings/${encodeURIComponent(pnr)}/refund`, undefined, "Couldn't get a refund quote.", f);

export const cancelBooking = (pnr: string, f: Fetch = defaultFetch) =>
  call<{ booking: Booking; promoted: number }>(`/bookings/${encodeURIComponent(pnr)}/cancel`, { method: "POST" }, "Couldn't cancel this booking.", f);

export const sendChat = (message: string, reset = false, f: Fetch = defaultFetch) =>
  call<ChatReply>("/chat", json({ message, reset }), "The assistant couldn't answer. Please try again.", f);
