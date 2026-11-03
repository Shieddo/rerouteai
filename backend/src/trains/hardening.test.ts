import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { send, serve } from "../../test/http.ts";
import { SESSION_COOKIE, createSessionToken } from "../auth/session.ts";
import { userStore } from "../auth/userstore.ts";
import { createApp } from "../server/app.ts";
import { RailRadarError, trainsBetween } from "./railradar.ts";

const realFetch = globalThis.fetch;
const realKey = process.env["RAILRADAR_API_KEY"];
const realError = console.error;
let fetchCalls: string[];
let respond: () => Promise<Response>;

beforeEach(() => {
  fetchCalls = [];
  respond = async () => new Response(JSON.stringify({ success: true, data: { from: { code: "A", name: "A" }, to: { code: "B", name: "B" }, trains: [] } }));
  globalThis.fetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return respond();
  }) as unknown as typeof fetch;
  process.env["RAILRADAR_API_KEY"] = "test-key-never-sent-anywhere";
  console.error = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  if (realKey === undefined) delete process.env["RAILRADAR_API_KEY"];
  else process.env["RAILRADAR_API_KEY"] = realKey;
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as RailRadarError;
  }
  throw new Error("expected a failure");
}

describe("RailRadar client hardening", () => {
  test("upstream error text and our key/quota problems never reach callers", async () => {
    respond = async () => new Response(JSON.stringify({ success: false, error: { message: "quota exceeded for key test-key-never-sent-anywhere on plan pro" } }), { status: 429 });
    const err = await failure(trainsBetween({ from: "AAA", to: "BBB", type: "t1" }));
    expect(err).toBeInstanceOf(RailRadarError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("Train search is temporarily unavailable");
    expect(err.message).not.toContain("quota");
  });

  test("a missing API key is a generic 503, not a configuration leak", async () => {
    delete process.env["RAILRADAR_API_KEY"];
    const err = await failure(trainsBetween({ from: "AAA", to: "BBB", type: "t2" }));
    expect(err.status).toBe(503);
    expect(err.message).not.toContain("RAILRADAR");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a network failure or timeout is a generic 504", async () => {
    respond = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    const err = await failure(trainsBetween({ from: "AAA", to: "BBB", type: "t3" }));
    expect(err.status).toBe(504);
    expect(err.message).toBe("Train search is temporarily unavailable");
  });

  test("upstream 400/404 become a fixed 'no data' message with the same status", async () => {
    respond = async () => new Response(JSON.stringify({ success: false, error: { message: "internal: bad station index 77" } }), { status: 404 });
    const err = await failure(trainsBetween({ from: "AAA", to: "BBB", type: "t4" }));
    expect(err.status).toBe(404);
    expect(err.message).toBe("No train data found for that search");
  });

  test("requests carry a timeout signal", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return respond();
    }) as unknown as typeof fetch;
    await trainsBetween({ from: "AAA", to: "BBB", type: "t5" });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("the response cache is bounded, evicting the oldest entries", async () => {
    for (let i = 0; i < 520; i++) await trainsBetween({ from: "AAA", to: "BBB", type: `bound${i}` });
    expect(fetchCalls).toHaveLength(520);
    await trainsBetween({ from: "AAA", to: "BBB", type: "bound519" }); // still cached
    expect(fetchCalls).toHaveLength(520);
    await trainsBetween({ from: "AAA", to: "BBB", type: "bound0" }); // evicted long ago
    expect(fetchCalls).toHaveLength(521);
  });
});

describe("search input validation", () => {
  let base: string;
  let close: () => void;
  let cookie: string;
  let savedSecret: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env["SESSION_SECRET"];
    process.env["SESSION_SECRET"] = "hardening-test-secret-0123456789abcd";
    ({ base, close } = await serve(createApp({ SESSION_SECRET: process.env["SESSION_SECRET"], BASE_URL: "http://localhost:8000" })));
    const user = await userStore.create({ email: "h@example.com", name: "H", provider: "github", providerId: `hard-${Date.now()}` });
    cookie = `${SESSION_COOKIE}=${createSessionToken(user.id)}`;
  });
  afterAll(() => {
    close();
    if (savedSecret === undefined) delete process.env["SESSION_SECRET"];
    else process.env["SESSION_SECRET"] = savedSecret;
  });

  const get = (path: string) => send(base, path, { headers: { Cookie: cookie } });

  test.each([
    ["type with path characters", "type=a/../b"],
    ["type with a query-string break", "type=a%26byCity%3Dtrue"],
    ["an over-long category", `category=${"a".repeat(33)}`],
    ["control characters", "type=a%0d%0ab"],
  ])("rejects %s before any upstream call", async (_name, extra) => {
    const r = await get(`/trains/search?from=NDLS&to=AGC&${extra}`);
    expect(r.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  test("an over-long station query is rejected", async () => {
    expect((await get(`/stations/search?q=${"a".repeat(101)}`)).status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  test("station search is served from the dataset, with no RailRadar key and no upstream calls", async () => {
    delete process.env["RAILRADAR_API_KEY"];
    const r = await get("/stations/search?q=new delhi");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)[0]).toMatchObject({ code: "NDLS", name: "New Delhi" });
    expect(fetchCalls).toHaveLength(0);
  });
});
