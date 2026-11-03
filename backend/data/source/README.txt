EXPANDED INDIAN RAILWAY ROUTE + SYNTHETIC AVAILABILITY DATASET

WHAT IS REAL VS SIMULATED
- Real reference data: train numbers, train names, ordered stop sequences, station names/codes, and scheduled arrival/departure times from the September 2024 timetable snapshot. The subset includes 120 actual train services and 5303 scheduled stop rows.
- Simulated: availability snapshots, seat counts, RAC/waitlist status, fares, booking outcomes, cancellation outcomes/refunds, and confirmation labels. These are generated examples, not historical IRCTC data or official rules.
- Transfer options use the sampled timetable times, but operating-day overlap was not available in the source. `service_days_verified=false` means the timetable alone does not prove both trains run on that date.

FILES
stations.csv: 1391 real stations; codes/names from the timetable snapshot, zone where available, coordinates for selected core stations only.
trains.csv: 120 actual train numbers and names, route endpoints, stop counts, and schedule provenance.
train_stops.csv: 5303 real timetable stop rows with arrival/departure time, service-day offset, and distance.
availability_training.csv: 90432 synthetic labelled segment snapshots. Targets include availability_status, seats_available, waitlist_position, confirmed_by_chart, total_fare_inr.
route_options_training.csv: 3700 direct or two-train candidate itineraries; targets include connection_feasible and all_legs_confirmed_by_chart.
booking_cancellation_training.csv: 90432 synthetic booking/cancellation rows; targets include booking_result, cancelled, and refund_amount_inr. Refund formula is illustrative only.

JOIN KEYS
train_id joins trains, train_stops, availability, booking/cancellation, and route options. station_code joins station records to stop and from/to/transfer station fields.

MODELING
For availability prediction, exclude snapshot_id and use availability_status as the target. For confirmation prediction, use confirmed_by_chart as target and exclude it from features. For route ranking, use route options and select a target such as connection_feasible or all_legs_confirmed_by_chart. Use grouped/time-based splits to avoid leakage between repeated observations of the same train and segment.

The synthetic labels follow simple random rules and are suitable for demonstrating data pipelines only. They cannot guarantee seats or represent real-world booking probabilities. Replace them with permissioned actual availability snapshots for research claims.

SOURCE
K. Chowdhury et al., Indian Railway Network and Delays dataset, train_routes_Sep2024.csv, September 2024 timetable snapshot: https://github.com/KoyenaChowdhury/RSTGCN (repository includes source and data description).
