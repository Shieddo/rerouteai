// AI ticket assistant: a Groq-hosted model (OpenAI-compatible chat completions) with tools that
// call the same planner and booking code as the API. The model never sees or invents fares and
// trains on its own; everything comes from tool results. Conversation state is kept per user on
// the server, so option ids from an earlier search stay usable when the user says "book option 2".

import { autoBook, bookOption, cancelBooking, getBooking, listBookings, refundQuote, type Booking } from "../dataset/bookings.ts";
import { CLASSES, CLASS_LABELS, isClassCode, type ClassCode } from "../dataset/fares.ts";
import { BERTH_TYPES, type BerthType } from "../dataset/inventory.ts";
import { planTrip, PREFERENCES, todayIst, type PlanOption, type PlanRequest, type Preference } from "../dataset/planner.ts";
import { loadTimetable } from "../dataset/timetable.ts";
import { searchDatasetStations } from "../dataset/stations.ts";
import { weekdayOf } from "../rail/time.ts";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatReply = {
  reply: string;
  /** Options from the latest search this turn, for the UI to render as bookable cards. */
  options: PlanOption[];
  /** Bookings created, cancelled or listed this turn. */
  bookings: Booking[];
};

export class ChatError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 30;
const SESSION_TTL_MS = 2 * 60 * 60_000;

const sessions = new Map<string, { messages: Message[]; touched: number }>();

export function resetChat(userId: string) {
  sessions.delete(userId);
}

// ---- Tools --------------------------------------------------------------------------------

const planParams = {
  from: { type: "string", description: "Origin station code, e.g. NDLS. Use search_stations to find codes." },
  to: { type: "string", description: "Destination station code." },
  date: { type: "string", description: "Travel date YYYY-MM-DD." },
  class_code: { type: "string", enum: [...CLASSES], description: "SL sleeper, 3A AC 3-tier, 2A AC 2-tier, CC AC chair car." },
  passengers: { type: "integer", minimum: 1, maximum: 6 },
  preference: { type: "string", enum: [...PREFERENCES], description: "How to rank options. 'confirmed' puts seat certainty first." },
  earliest_time: { type: "string", description: "Earliest departure HH:MM (optional)." },
  flexible_days: { type: "integer", minimum: 0, maximum: 2, description: "Also search this many days either side." },
  max_transfers: { type: "integer", minimum: 0, maximum: 3 },
  berth_preference: { type: "string", enum: [...BERTH_TYPES] },
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_stations",
      description: "Find station codes by city or station name. Call this whenever the user names a place rather than a code.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_trip",
      description:
        "Search every direct and connecting train combination, check berths (including berth changes within a train and Tatkal), and return ranked options with fares, seat status and a class price comparison.",
      parameters: { type: "object", properties: planParams, required: ["from", "to", "date", "class_code", "passengers"] },
    },
  },
  {
    type: "function",
    function: {
      name: "book_option",
      description: "Book one option returned by plan_trip. Only call after the user explicitly confirms which option to book.",
      parameters: { type: "object", properties: { option_id: { type: "string" } }, required: ["option_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_book",
      description:
        "Booking automation: search and book the best option meeting the conditions in one step. Only call when the user explicitly asks you to book automatically.",
      parameters: {
        type: "object",
        properties: {
          ...planParams,
          max_fare: { type: "number", description: "Total fare limit in INR." },
          require_confirmed: { type: "boolean", description: "Only book confirmed berths (default true)." },
          allow_berth_change: { type: "boolean", description: "Allow changing berth mid-train (default true)." },
        },
        required: ["from", "to", "date", "class_code", "passengers"],
      },
    },
  },
  { type: "function", function: { name: "list_bookings", description: "List the user's bookings.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "refund_quote",
      description: "How much cancelling a booking now would refund.",
      parameters: { type: "object", properties: { pnr: { type: "string" } }, required: ["pnr"] },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_booking",
      description: "Cancel a booking. Only call after the user has seen the refund amount and explicitly confirmed.",
      parameters: { type: "object", properties: { pnr: { type: "string" } }, required: ["pnr"] },
    },
  },
];

type Collect = { options: PlanOption[]; bookings: Map<string, Booking> };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

function toPlanRequest(a: Record<string, unknown>): PlanRequest {
  const classCode = str(a["class_code"])?.toUpperCase();
  const preference = str(a["preference"]);
  const berth = str(a["berth_preference"])?.toUpperCase();
  return {
    from: str(a["from"]) ?? "",
    to: str(a["to"]) ?? "",
    date: str(a["date"]) ?? "",
    classCode: (isClassCode(classCode) ? classCode : "SL") as ClassCode,
    passengers: int(a["passengers"]) ?? 1,
    ...(PREFERENCES.includes(preference as Preference) && { preference: preference as Preference }),
    ...(str(a["earliest_time"]) && /^\d{2}:\d{2}$/.test(str(a["earliest_time"])!) && { time: str(a["earliest_time"])! }),
    ...(int(a["flexible_days"]) !== undefined && { flexibleDays: int(a["flexible_days"])! }),
    ...(int(a["max_transfers"]) !== undefined && { maxTransfers: Math.min(3, int(a["max_transfers"])!) }),
    ...(BERTH_TYPES.includes(berth as BerthType) && { berthPreference: berth as BerthType }),
  };
}

const istShort = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const compactOption = (o: PlanOption) => ({
  option_id: o.id,
  summary: o.summary,
  departs: istShort.format(new Date(o.journey.departure)),
  arrives: istShort.format(new Date(o.journey.arrival)),
  fare_inr: o.totalFare,
  seat_status: o.guaranteed
    ? "CONFIRMED on every leg"
    : `NOT CONFIRMED (${Math.round(o.confirmChance * 100)}% chance): ` +
      o.legs.filter((l) => l.status === "WAITLIST" || l.status === "RAC").map((l) => `${l.trainNumber} ${l.status === "RAC" ? `RAC ${l.racPosition}` : `WL ${l.waitlistPosition}`}`).join(", "),
  tags: o.tags,
});

const compactBooking = (b: Booking) => ({
  pnr: b.pnr,
  status: b.status,
  route: `${b.source.name} → ${b.destination.name}`,
  departure: b.departure,
  class: b.classCode,
  passengers: b.passengers,
  total_fare_inr: b.totalFare,
  legs: b.legs.map((l) => ({
    train: `${l.trainNumber} ${l.trainName}`,
    from: l.from.name,
    to: l.to.name,
    status: l.status,
    ...(l.waitlistPosition && { waitlist_position: l.waitlistPosition }),
    ...(l.racPosition && { rac_position: l.racPosition }),
    berths: l.berths.map((p) => p.pieces.map((x) => `${x.berth} ${x.from.code}-${x.to.code}`).join(" then ")),
  })),
  refund: b.refund,
});

async function runTool(userId: string, name: string, args: Record<string, unknown>, collect: Collect): Promise<unknown> {
  switch (name) {
    case "search_stations":
      return (await searchDatasetStations(str(args["query"]) ?? "", 8)).map((s) => ({ code: s.code, name: s.name }));
    case "plan_trip": {
      const plan = await planTrip(toPlanRequest(args), userId);
      collect.options = plan.options;
      return {
        searched: `${plan.request.from}→${plan.request.to} ${plan.request.date} ${plan.request.classCode} x${plan.request.passengers}`,
        options: plan.options.slice(0, 5).map(compactOption),
        more_options_in_app: Math.max(0, plan.options.length - 5),
        class_comparison: plan.classComparison.map((c) => `${c.classCode} ₹${c.fare} ${c.status}`).join("; "),
        notes: plan.notes,
      };
    }
    case "book_option": {
      const booking = await bookOption(userId, str(args["option_id"]) ?? "");
      collect.bookings.set(booking.pnr, booking);
      return compactBooking(booking);
    }
    case "auto_book": {
      const maxFare = typeof args["max_fare"] === "number" ? args["max_fare"] : undefined;
      const result = await autoBook(userId, {
        ...toPlanRequest(args),
        ...(maxFare !== undefined && { maxFare }),
        ...(typeof args["require_confirmed"] === "boolean" && { requireConfirmed: args["require_confirmed"] }),
        ...(typeof args["allow_berth_change"] === "boolean" && { allowBerthChange: args["allow_berth_change"] }),
      });
      if (result.booking) collect.bookings.set(result.booking.pnr, result.booking);
      return { message: result.message, booking: result.booking && compactBooking(result.booking), attempts: result.attempts.slice(0, 8) };
    }
    case "list_bookings": {
      const list = listBookings(userId);
      for (const b of list) collect.bookings.set(b.pnr, b);
      return list.map(compactBooking);
    }
    case "refund_quote": {
      const booking = getBooking(userId, str(args["pnr"]) ?? "");
      if (!booking) return { error: "No booking with that PNR." };
      return refundQuote(booking) ?? { error: "Already cancelled." };
    }
    case "cancel_booking": {
      const { booking, promoted } = await cancelBooking(userId, str(args["pnr"]) ?? "");
      collect.bookings.set(booking.pnr, booking);
      return { ...compactBooking(booking), other_passengers_confirmed_from_waitlist: promoted.length };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// ---- Conversation -------------------------------------------------------------------------

async function systemPrompt(): Promise<string> {
  const today = todayIst();
  const tt = await loadTimetable();
  return [
    "You are Reroute's train ticket assistant for Indian Railways journeys. You help people find and book tickets that are actually confirmed.",
    `Today is ${today} (${weekdayOf(today)}), Indian Standard Time. Resolve relative dates ("tomorrow", "next Friday") from this.`,
    `The network has ${tt.trains.length} trains and ${tt.stations.length} stations from a Sept 2024 timetable snapshot; seat availability and fares are simulated.`,
    "Rules:",
    "- Never invent trains, times, fares, availability, PNRs or station codes. Use tools for all of them.",
    "- When the user names a city or station, call search_stations to get codes. If several stations match, pick the main one and say which.",
    "- To find tickets call plan_trip. If class or passenger count are not given, assume SL and 1 passenger and say so. Ask only if origin, destination or date is missing.",
    "- Options with guaranteed_seats=true have confirmed berths now. BERTH_CHANGE means separate tickets on the same train: the passenger moves to another berth at the named station, without leaving the train. TATKAL is the higher-priced quota that opens 1 day before. RAC means a shared side berth; WAITLIST may not confirm, so mention confirm_chance.",
    "- Options come ranked best first, fully confirmed ones before the rest. Highlight at most 3 in one or two lines each, citing the rank number (#1, #2...). Describe each with its seat_status and tags exactly as given: never call an option confirmed unless seat_status says CONFIRMED, and never invent labels. Mention the class price comparison when another class has confirmed seats. The app shows full option cards with Book buttons under your message, so keep text short.",
    "- Book (book_option) only after the user clearly says which option to book. Use auto_book only when the user asks you to book automatically or 'just book the best'.",
    "- Before cancel_booking, call refund_quote, tell the user the refund, and wait for an explicit yes.",
    `- Classes: ${CLASSES.map((c) => `${c} = ${CLASS_LABELS[c]}`).join(", ")}. Fares are in INR (₹).`,
    "- Be concise and friendly. Use short paragraphs or a compact list. No tables.",
  ].join("\n");
}

const OLD_TOOL_RESULT_CHARS = 1500;

/**
 * Keeps the token budget small (Groq's free tier allows ~8k tokens/minute): drops old turns, cut at
 * a user message so tool calls and results stay paired, and shortens tool results from earlier
 * turns. The latest search is kept whole so "book option 2" still has its option ids.
 */
function trimHistory(messages: Message[]): Message[] {
  let start = Math.max(0, messages.length - MAX_HISTORY);
  while (start > 0 && start < messages.length && messages[start]!.role !== "user") start++;
  const kept = messages.slice(start);
  const lastUser = kept.map((m) => m.role).lastIndexOf("user");
  let lastPlan = -1;
  kept.forEach((m, i) => {
    if (m.role === "tool" && m.content.includes('"option_id"')) lastPlan = i;
  });
  return kept.map((m, i) =>
    m.role === "tool" && i < lastUser && i !== lastPlan && m.content.length > OLD_TOOL_RESULT_CHARS
      ? { ...m, content: `${m.content.slice(0, OLD_TOOL_RESULT_CHARS)}…(truncated)` }
      : m,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function complete(messages: Message[], apiKey: string, model: string, retried = false): Promise<{ content?: string | null; tool_calls?: ToolCall[] }> {
  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
        max_completion_tokens: 900,
        ...(model.startsWith("openai/gpt-oss") && { reasoning_effort: "low" }),
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ChatError("The assistant is not responding. Please try again.", 504);
  }
  if (res.status === 429) {
    // Per-minute token budget: wait once if the reset is close, otherwise tell the user.
    const wait = Number(res.headers.get("retry-after"));
    if (!retried && Number.isFinite(wait) && wait > 0 && wait <= 25) {
      await sleep(wait * 1000 + 250);
      return complete(messages, apiKey, model, true);
    }
    throw new ChatError("The assistant is busy right now. Try again in a minute.", 429);
  }
  if (!res.ok) {
    console.error(`Groq error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 500)}`);
    throw new ChatError("The assistant had a problem. Please try again.");
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
  const message = body.choices?.[0]?.message;
  if (!message) throw new ChatError("The assistant returned an empty reply.");
  return message;
}

export async function chat(userId: string, text: string, env: Record<string, string | undefined> = process.env): Promise<ChatReply> {
  const apiKey = env["GROQ_API_KEY"];
  if (!apiKey) throw new ChatError("The AI assistant is not configured (GROQ_API_KEY is missing).", 503);
  const model = env["GROQ_MODEL"] || "openai/gpt-oss-120b";

  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(k);
  const session = sessions.get(userId) ?? { messages: [], touched: now };
  session.touched = now;
  session.messages.push({ role: "user", content: text });
  session.messages = trimHistory(session.messages);
  sessions.set(userId, session);

  const collect: Collect = { options: [], bookings: new Map() };
  const system: Message = { role: "system", content: await systemPrompt() };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    session.messages = trimHistory(session.messages);
    const message = await complete([system, ...session.messages], apiKey, model);
    const calls = round < MAX_TOOL_ROUNDS ? (message.tool_calls ?? []) : [];
    session.messages.push({ role: "assistant", content: message.content ?? null, ...(calls.length && { tool_calls: calls }) });
    if (!calls.length) {
      return { reply: message.content?.trim() || "Sorry, I couldn't put an answer together. Could you rephrase?", options: collect.options, bookings: [...collect.bookings.values()] };
    }
    for (const call of calls) {
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        if (env["CHAT_DEBUG"] === "true") console.log(`[chat] ${call.function.name} ${JSON.stringify(args)}`);
        result = await runTool(userId, call.function.name, args, collect);
      } catch (err) {
        // Planner/booking errors are user-facing messages; let the model explain them.
        result = { error: err instanceof Error ? err.message : "Tool failed" };
      }
      session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
    }
  }
  return { reply: "That took too many steps. Could you narrow the request down?", options: collect.options, bookings: [...collect.bookings.values()] };
}
