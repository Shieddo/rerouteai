// Fare and refund rules shared by the app and by scripts/alignDataset.ts, so the published CSVs
// and every price the app quotes come from the same formula.
//
// Fare constants are a least-squares fit (fare = base + perKm * km) over the original
// availability_training.csv, rounded. Tatkal (TQ) was a near-constant 1.18x of general quota in
// every class, so it is modelled as a multiplier. The refund curve reproduces the original
// booking_cancellation_training.csv exactly: 35% on the day, +7% per day before, capped at 95%.

export const CLASSES = ["SL", "3A", "2A", "CC"] as const;
export type ClassCode = (typeof CLASSES)[number];
export const QUOTAS = ["GN", "TQ"] as const;
export type Quota = (typeof QUOTAS)[number];

export const CLASS_LABELS: Record<ClassCode, string> = {
  SL: "Sleeper",
  "3A": "AC 3 Tier",
  "2A": "AC 2 Tier",
  CC: "AC Chair Car",
};

const FARE_TABLE: Record<ClassCode, { base: number; perKm: number }> = {
  SL: { base: 30, perKm: 1.06 },
  "3A": { base: 90, perKm: 2.07 },
  "2A": { base: 140, perKm: 2.93 },
  CC: { base: 57, perKm: 1.665 },
};

export const TATKAL_MULTIPLIER = 1.18;
/** Short hops are charged as at least this distance. */
export const MIN_CHARGEABLE_KM = 20;

export const isClassCode = (v: unknown): v is ClassCode => CLASSES.includes(v as ClassCode);
export const isQuota = (v: unknown): v is Quota => QUOTAS.includes(v as Quota);

const roundTo5 = (n: number) => Math.round(n / 5) * 5;

/** Fare per passenger in INR, rounded to the nearest ₹5. */
export function farePerPassenger(classCode: ClassCode, quota: Quota, distanceKm: number): number {
  const { base, perKm } = FARE_TABLE[classCode];
  const general = base + perKm * Math.max(distanceKm, MIN_CHARGEABLE_KM);
  return roundTo5(quota === "TQ" ? general * TATKAL_MULTIPLIER : general);
}

export function fareFor(classCode: ClassCode, quota: Quota, distanceKm: number, passengers = 1): number {
  return farePerPassenger(classCode, quota, distanceKm) * passengers;
}

/** Share of the fare refunded when cancelling `daysBefore` days before departure. */
export function refundRatio(daysBefore: number): number {
  if (daysBefore < 0) return 0;
  return Math.min(95, 35 + 7 * Math.floor(daysBefore)) / 100;
}

export function refundFor(fare: number, daysBefore: number): number {
  return Math.round(fare * refundRatio(daysBefore) * 100) / 100;
}

export const REFUND_RULE = "35% on departure day +7%/day before, max 95%";

/** A waitlisted ticket still unconfirmed at chart time is cancelled automatically. */
export const WAITLIST_CLERKAGE = 20;
export const WAITLIST_REFUND_RULE = `Waitlist not confirmed at chart: full refund minus ₹${WAITLIST_CLERKAGE} per passenger`;

export function waitlistRefund(fare: number, passengers: number): number {
  return Math.max(0, fare - WAITLIST_CLERKAGE * passengers);
}
