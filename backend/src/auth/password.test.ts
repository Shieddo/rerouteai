import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { send, serve, setCookies, type Reply } from "../../test/http.ts";
import { createAuthRouter } from "./authcontroller.ts";
import { normaliseEmail, passwordProblem, signInWithPassword, signUpWithPassword } from "./password.ts";
import { SESSION_COOKIE } from "./session.ts";
import { userStore } from "./userstore.ts";

const SECRET = "test-only-secret-for-password-tests";
let originalSecret: string | undefined;
let base: string;
let close: () => void;

beforeAll(async () => {
  originalSecret = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = SECRET;
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter({ env: { SESSION_SECRET: SECRET } }));
  ({ base, close } = await serve(app));
});
afterAll(() => {
  close();
  if (originalSecret === undefined) delete process.env["SESSION_SECRET"];
  else process.env["SESSION_SECRET"] = originalSecret;
});

const post = (path: string, body: unknown) => send(base, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const cookieOf = (r: Reply) => setCookies(r).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];

describe("rules", () => {
  test("emails are trimmed and lower-cased; junk is rejected", () => {
    expect(normaliseEmail("  Asha@Example.COM ")).toBe("asha@example.com");
    expect(normaliseEmail("not-an-email")).toBeNull();
    expect(normaliseEmail(42)).toBeNull();
  });

  test("passwords need 8-128 characters with a letter and a number", () => {
    expect(passwordProblem("short1")).toContain("at least 8");
    expect(passwordProblem("onlyletters")).toContain("letter and one number");
    expect(passwordProblem("12345678")).toContain("letter and one number");
    expect(passwordProblem("x1".repeat(65))).toContain("at most 128");
    expect(passwordProblem("trains2026")).toBeNull();
  });
});

describe("service", () => {
  test("stores an argon2id hash, never the password, and not on the user object", async () => {
    const user = await signUpWithPassword({ email: "hash@example.com", password: "trains2026" });
    expect(Object.keys(user)).not.toContain("passwordHash");
    const stored = await userStore.getPasswordHash(user.id);
    expect(stored).toStartWith("$argon2id$");
    expect(stored).not.toContain("trains2026");
  });

  test("sign-in matches the email case-insensitively", async () => {
    await signUpWithPassword({ email: "Case@Example.com", password: "trains2026" });
    expect((await signInWithPassword({ email: "CASE@example.COM", password: "trains2026" })).email).toBe("case@example.com");
  });

  test("an OAuth account with the same email is a different user and has no password", async () => {
    const oauth = await userStore.create({ email: "both@example.com", name: null, provider: "github", providerId: "gh-both" });
    await expect(signInWithPassword({ email: "both@example.com", password: "trains2026" })).rejects.toThrow("Incorrect email or password");
    const pw = await signUpWithPassword({ email: "both@example.com", password: "trains2026" });
    expect(pw.id).not.toBe(oauth.id);
  });
});

describe("HTTP", () => {
  test("sign up sets a session that /me accepts, without exposing the hash", async () => {
    const r = await post("/auth/password/signup", { email: "asha@example.com", password: "trains2026", name: "Asha" });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body)).toMatchObject({ email: "asha@example.com", name: "Asha", provider: "password" });
    const cookie = cookieOf(r)!;
    expect(cookie).toBeDefined();
    const me = await send(base, "/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(me.body).not.toContain("argon2");
    expect(JSON.parse(me.body)).toMatchObject({ email: "asha@example.com", provider: "password" });
  });

  test("signing up twice with one email is a 409", async () => {
    await post("/auth/password/signup", { email: "twice@example.com", password: "trains2026" });
    const r = await post("/auth/password/signup", { email: "TWICE@example.com", password: "other2026x" });
    expect(r.status).toBe(409);
  });

  test("weak passwords and bad emails are a 400 with a reason", async () => {
    expect((await post("/auth/password/signup", { email: "weak@example.com", password: "password" })).status).toBe(400);
    expect((await post("/auth/password/signup", { email: "nope", password: "trains2026" })).status).toBe(400);
  });

  test("sign in: right password works; wrong password and unknown email look identical", async () => {
    await post("/auth/password/signup", { email: "ravi@example.com", password: "trains2026" });
    const ok = await post("/auth/password/signin", { email: "ravi@example.com", password: "trains2026" });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toBeDefined();

    const wrong = await post("/auth/password/signin", { email: "ravi@example.com", password: "wrong2026" });
    const unknown = await post("/auth/password/signin", { email: "ghost@example.com", password: "wrong2026" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(cookieOf(wrong)).toBeUndefined();
  });

  test("repeated guesses against one email are rate limited", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post("/auth/password/signin", { email: "target@example.com", password: `guess${i}aaaa` })).status;
    expect(last).toBe(429);
  });
});
