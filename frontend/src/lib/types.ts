// Mirrors backend/src/rail/types.ts, journey.ts and journeys/types.ts. Keep in sync with the API.
export type Station = {
  /** Stable unique identifier; what the app keys selections and train stops on. */
  id: string;
  name: string;
  /** Official station code, when the data source has one. */
  code?: string;
  city: string;
};

export type IsoDate = string;
export const TRAIN_TYPES = [
  "vande-bharat",
  "rajdhani",
  "shatabdi",
  "duronto",
  "superfast",
  "express",
  "passenger",
] as const;
export type TrainType = (typeof TRAIN_TYPES)[number];



export type JourneyStation = { id: string; code?: string; name: string };

export type JourneyLeg = {
  trainNumber: string;
  trainName: string;
  trainType: TrainType;
  /** The date this run left its origin; identifies the particular run of the train. */
  originDate: IsoDate;
  from: JourneyStation;
  to: JourneyStation;
  departure: string;
  arrival: string;
  durationMinutes: number;
  distanceKm: number;
};

export type JourneyTransfer = {
  station: JourneyStation;
  /** Arrival of the incoming train. */
  arrival: string;
  /** Departure of the outgoing train. */
  departure: string;
  waitMinutes: number;
  /** The buffer that applied at this station; waitMinutes is never below it. */
  requiredBufferMinutes: number;
};

export type JourneyWarningCode =
  | "NO_REAL_TIME_DATA"
  | "PLATFORM_CHANGE_UNVERIFIED"
  | "INCOMPLETE_TRAIN_SCHEDULE";

export type JourneyWarning = { code: JourneyWarningCode; message: string };

export type Journey = {
  source: JourneyStation;
  destination: JourneyStation;
  /** Ordered; consecutive legs meet at a transfer station. */
  legs: JourneyLeg[];
  /** One entry per pair of consecutive legs, so `transfers.length === legs.length - 1`. */
  transfers: JourneyTransfer[];
  transferCount: number;
  /** First boarding. */
  departure: string;
  /** Final alighting. */
  arrival: string;
  /** First boarding to final alighting, including waits at transfers. */
  totalDurationMinutes: number;
  ridingMinutes: number;
  /** Time spent waiting at transfer stations (not before the first train). */
  totalWaitMinutes: number;
  /** How long after the passenger's earliest departure the first train leaves. */
  startDelayMinutes: number;
  /** Always "schedule-feasible": timetable-only; live delays are not considered. */
  feasibility: "schedule-feasible";
  /** True when every connection meets the configured transfer rules. Returned journeys are always valid. */
  connectionConstraintsSatisfied: boolean;
  warnings: JourneyWarning[];
  /** Lower is better; see ranking.ts. */
  score: number;
};

export type SearchWarning = {
  code: "INCOMPLETE_SCHEDULE";
  trainNumber: string;
  message: string;
};

export type AlternativeSearchResult = {
  /** Best first. Empty when no schedule-feasible journey exists. */
  journeys: Journey[];
  /** Data problems met while searching, e.g. trains skipped or partly unusable. */
  warnings: SearchWarning[];
};


/** What the API returns for a saved journey. `journey` is exactly what the route search produced. */
export type SavedJourney = {
  /** Random UUID; ownership is always checked against the session, never inferred from the id. */
  id: string;
  /** ISO 8601, UTC. */
  savedAt: string;
  source: JourneyStation;
  destination: JourneyStation;
  /** Date of departure in IST, YYYY-MM-DD. */
  travelDate: string;
  journey: Journey;
};


// ---- Planner and bookings (mirrors backend/src/dataset/planner.ts and bookings.ts) ----------

export const CLASS_OPTIONS = [
  { code: "SL", label: "Sleeper (SL)" },
  { code: "3A", label: "AC 3 Tier (3A)" },
  { code: "2A", label: "AC 2 Tier (2A)" },
  { code: "CC", label: "AC Chair Car (CC)" },
] as const;
export type ClassCode = (typeof CLASS_OPTIONS)[number]["code"];
export type Preference = "balanced" | "cheapest" | "fastest" | "confirmed";
export type BerthType = "LB" | "MB" | "UB" | "SL" | "SU" | "WS" | "MS" | "AS";

export type LegStatus = "CONFIRMED" | "BERTH_CHANGE" | "TATKAL" | "TATKAL_BERTH_CHANGE" | "RAC" | "WAITLIST" | "CLOSED";

export type BerthAssignment = {
  passenger: number;
  pieces: { berth: string; type: string; from: JourneyStation; to: JourneyStation }[];
};

export type PlannedLeg = JourneyLeg & {
  classCode: ClassCode;
  quota: "GN" | "TQ";
  status: LegStatus;
  seatsAvailable: number;
  racPosition: number | null;
  waitlistPosition: number | null;
  confirmChance: number;
  berths: BerthAssignment[];
  berthChangeStations: JourneyStation[];
  fare: number;
  singleTicketFare: number;
};

export type PlanOption = {
  id: string;
  rank: number;
  journey: Omit<Journey, "legs">;
  legs: PlannedLeg[];
  classCode: ClassCode;
  passengers: number;
  totalFare: number;
  guaranteed: boolean;
  confirmChance: number;
  berthChanges: number;
  tags: string[];
  summary: string;
};

export type ClassQuote = { classCode: ClassCode; label: string; fare: number; status: LegStatus; confirmChance: number };

export type PlanResult = { options: PlanOption[]; classComparison: ClassQuote[]; notes: string[] };

export type BookingStatus = "CONFIRMED" | "PARTIALLY_CONFIRMED" | "WAITLISTED" | "CANCELLED";

export type BookedLeg = Omit<PlannedLeg, "seatsAvailable" | "confirmChance" | "singleTicketFare" | "durationMinutes" | "distanceKm" | "trainType">;

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
  history: { at: string; message: string }[];
};

export type RefundQuote = { amount: number; rule: string; daysBefore: number; ratio: number };

export type ChatReply = { reply: string; options: PlanOption[]; bookings: Booking[] };
