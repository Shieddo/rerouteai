// HTTP API for the seat-guaranteeing planner, bookings and the AI assistant. Every route needs a
// signed-in user; bookings are always scoped to req.user.id. CSRF (Origin check on unsafe
// methods), security headers and per-IP limits come from server/app.ts.

import { Router, type Response } from "express";
import { requireAuth } from "../auth/middleware.ts";
import { chat, ChatError, resetChat } from "../chat/assistant.ts";
import { rateLimit } from "../server/security.ts";
import { autoBook, bookOption, BookingError, cancelBooking, getBooking, listBookings, refundQuote, type AutoBookRequest } from "./bookings.ts";
import { isClassCode } from "./fares.ts";
import { BERTH_TYPES, type BerthType } from "./inventory.ts";
import { planTrip, PlanError, PREFERENCES, type PlanRequest, type Preference } from "./planner.ts";

const perUser = (max: number) => rateLimit({ windowMs: 60_000, max, key: (req) => `user:${req.user?.id}` });

class InputError extends Error {}

const STATION = /^[A-Z0-9]{1,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PNR = /^\d{10}$/;
const UUID = /^[0-9a-f-]{36}$/i;

function value(source: Record<string, unknown>, name: string): string | undefined {
  const v = source[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") throw new InputError(`${name} is invalid`);
  return v;
}

function intIn(source: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const v = value(source, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new InputError(`${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

/** Shared by GET /plan (query string) and POST /bookings/auto (JSON body). */
function parsePlan(source: Record<string, unknown>): PlanRequest {
  const from = value(source, "from")?.toUpperCase();
  const to = value(source, "to")?.toUpperCase();
  if (!from || !to || !STATION.test(from) || !STATION.test(to)) throw new InputError("from and to are required station codes, e.g. NDLS");
  if (from === to) throw new InputError("from and to must be different stations");
  const date = value(source, "date");
  if (!date || !DATE.test(date)) throw new InputError("date is required as YYYY-MM-DD");
  const time = value(source, "time");
  if (time !== undefined && !TIME.test(time)) throw new InputError("time must be HH:MM");
  const classCode = (value(source, "class") ?? "SL").toUpperCase();
  if (!isClassCode(classCode)) throw new InputError("class must be SL, 3A, 2A or CC");
  const preference = value(source, "preference");
  if (preference !== undefined && !PREFERENCES.includes(preference as Preference)) throw new InputError(`preference must be one of ${PREFERENCES.join(", ")}`);
  const berth = value(source, "berth")?.toUpperCase();
  if (berth !== undefined && !BERTH_TYPES.includes(berth as BerthType)) throw new InputError(`berth must be one of ${BERTH_TYPES.join(", ")}`);
  const passengers = intIn(source, "passengers", 1, 6) ?? 1;
  const maxTransfers = intIn(source, "maxTransfers", 0, 3);
  const flexibleDays = intIn(source, "flexibleDays", 0, 2);
  const maxBerthChanges = intIn(source, "maxBerthChanges", 0, 3);
  return {
    from,
    to,
    date,
    classCode,
    passengers,
    ...(time && { time }),
    ...(preference && { preference: preference as Preference }),
    ...(berth && { berthPreference: berth as BerthType }),
    ...(maxTransfers !== undefined && { maxTransfers }),
    ...(flexibleDays !== undefined && { flexibleDays }),
    ...(maxBerthChanges !== undefined && { maxBerthChanges }),
  };
}

function fail(res: Response, err: unknown) {
  if (err instanceof InputError) return void res.status(400).json({ error: err.message });
  if (err instanceof PlanError || err instanceof BookingError || err instanceof ChatError) return void res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

export function createDatasetRouter() {
  const router = Router();

  /** GET /plan?from=NDLS&to=CSMT&date=2026-12-20[&time=&class=3A&passengers=2&preference=&berth=LB&maxTransfers=&flexibleDays=] */
  router.get("/plan", requireAuth, perUser(40), async (req, res) => {
    try {
      res.json(await planTrip(parsePlan(req.query as Record<string, unknown>), String(req.user!.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  /** POST /bookings { optionId } -> 201 { booking } */
  router.post("/bookings", requireAuth, perUser(20), async (req, res) => {
    try {
      const optionId = value(req.body ?? {}, "optionId");
      if (!optionId || !UUID.test(optionId)) throw new InputError("optionId is required");
      res.status(201).json({ booking: await bookOption(String(req.user!.id), optionId, { requireConfirmed: req.body?.requireConfirmed === true }) });
    } catch (err) {
      fail(res, err);
    }
  });

  /** POST /bookings/auto { from, to, date, class, passengers, preference?, maxFare?, requireConfirmed?, allowBerthChange? } */
  router.post("/bookings/auto", requireAuth, perUser(10), async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const maxFare = value(body, "maxFare");
      if (maxFare !== undefined && !(Number(maxFare) > 0)) throw new InputError("maxFare must be a positive number");
      const request: AutoBookRequest = {
        ...parsePlan(body),
        ...(maxFare !== undefined && { maxFare: Number(maxFare) }),
        ...(typeof body["requireConfirmed"] === "boolean" && { requireConfirmed: body["requireConfirmed"] }),
        ...(typeof body["allowBerthChange"] === "boolean" && { allowBerthChange: body["allowBerthChange"] }),
      };
      const result = await autoBook(String(req.user!.id), request);
      res.status(result.booking ? 201 : 200).json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  /** GET /bookings -> { bookings } newest first */
  router.get("/bookings", requireAuth, perUser(120), (req, res) => {
    res.json({ bookings: listBookings(String(req.user!.id)) });
  });

  /** GET /bookings/:pnr/refund -> refund quote if cancelled now */
  router.get("/bookings/:pnr/refund", requireAuth, perUser(60), (req, res) => {
    const pnr = String(req.params["pnr"]);
    const booking = PNR.test(pnr) ? getBooking(String(req.user!.id), pnr) : null;
    if (!booking) return void res.status(404).json({ error: "No booking with that PNR." });
    const quote = refundQuote(booking);
    if (!quote) return void res.status(409).json({ error: "This booking is already cancelled." });
    res.json(quote);
  });

  /** POST /bookings/:pnr/cancel -> { booking, promoted } */
  router.post("/bookings/:pnr/cancel", requireAuth, perUser(20), async (req, res) => {
    try {
      const pnr = String(req.params["pnr"]);
      if (!PNR.test(pnr)) throw new BookingError("No booking with that PNR.", 404);
      const { booking, promoted } = await cancelBooking(String(req.user!.id), pnr);
      res.json({ booking, promoted: promoted.length });
    } catch (err) {
      fail(res, err);
    }
  });

  /** POST /chat { message, reset? } -> { reply, options, bookings } */
  router.post("/chat", requireAuth, perUser(20), async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body["reset"] === true) resetChat(String(req.user!.id));
      const message = value(body, "message")?.trim();
      if (!message) {
        if (body["reset"] === true) return void res.json({ reply: "", options: [], bookings: [] });
        throw new InputError("message is required");
      }
      if (message.length > 1000) throw new InputError("message is too long (max 1000 characters)");
      res.json(await chat(String(req.user!.id), message));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
