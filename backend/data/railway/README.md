# Railway dataset (aligned)

This is the app's primary data source. It is generated from `../source/` (the original
"Expanded Indian Railway Route + Synthetic Availability Dataset") by:

```sh
bun run data:align        # bun scripts/alignDataset.ts data/source data/railway
```

## What alignment changes

| File | Change |
| --- | --- |
| `stations.csv` | Sorted by code; `city` column added. |
| `train_stops.csv` | 4 trains whose every stop had the origin's timestamp (12177, 18235, 22710, 22976) rebuilt from distance at the network's average speed + 5-minute halts, flagged `timetable_reconstructed`. |
| `trains.csv` | `train_type` inferred from the name, service days `daily (assumed)` (the source has none), `demand_index` from how full each train was in the source availability. |
| `availability_training.csv` | Status, seats, RAC/WL position, chart confirmation and fare recomputed from the berth simulator (`src/dataset/inventory.ts`) and fare rules (`src/dataset/fares.ts`); distance/duration from the timetable. Tatkal is CLOSED until 1 day before. |
| `booking_cancellation_training.csv` | One row per availability row, same fare and status. Booking result follows status (CONFIRMED / RAC / WAITLISTED / FAILED); cancellations only after booking; refunds by the rule below; unconfirmed waitlist auto-cancelled with ₹20/passenger clerkage. |
| `route_options_training.csv` | Times, waits, distance and fare recomputed from the timetable; feasibility uses the app's transfer rules (30 min buffer, 12 h max wait); confirmation from the simulator. |

Because the app answers availability, fares and bookings with the same code, every number here
matches what the app shows for the same train, segment, class and day. `src/dataset/dataset.test.ts`
recomputes a sample of rows to prove it.

## Rules

- Fare per passenger = base + per-km × km (fit to the source data), ×1.18 for Tatkal, rounded to ₹5.
  SL 30 + 1.06/km · 3A 90 + 2.07/km · 2A 140 + 2.93/km · CC 57 + 1.665/km.
- Refund on cancellation = 35% on the departure day + 7% per day before, max 95% (matches the source exactly).

Availability, fares and outcomes are simulated; timetables are a September 2024 snapshot.
