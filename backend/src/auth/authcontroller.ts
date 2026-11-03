import { Router, type Request, type Response } from "express";
import { AuthError, authorizeUrl, completeOAuth, type AuthMode } from "./authservice.ts";
import { sendAuthFailure, type AuthFailure } from "./errorpage.ts";
import { OAUTH_STATE_COOKIE, newOAuthState, openOAuthState, sameValue, sealOAuthState } from "./oauthstate.ts";
import { ProviderError, isProvider, providers as defaultProviders, type ProviderName, type Providers } from "./providers.ts";
import { requireAuth } from "./middleware.ts";
import { normaliseEmail, PasswordAuthError, signInWithPassword, signUpWithPassword } from "./password.ts";
import { rateLimit } from "../server/security.ts";
import { safeNextPath } from "./redirect.ts";
import { SESSION_COOKIE, createSessionToken, readCookie, sessionCookieClearOptions, sessionCookieOptions, verifySession } from "./session.ts";
import { userStore, type User } from "./userstore.ts";

type Env = Record<string, string | undefined>;
export type AuthRouterOptions = {
  providers?: Providers;
  env?: Env;
  /** Seconds since the epoch; injectable for expiry tests. */
  now?: () => number;
};

const MAX_PARAM_LENGTH = 2048;
const text = (value: unknown) => (typeof value === "string" && value !== "" && value.length <= MAX_PARAM_LENGTH ? value : undefined);

export function createAuthRouter({ providers = defaultProviders, env = process.env, now = () => Math.floor(Date.now() / 1000) }: AuthRouterOptions = {}) {
  const router = Router();
  const baseUrl = () => (env["BASE_URL"] ?? "http://localhost:8000").replace(/\/+$/, "");
  /** The callback URL registered with each provider: `${BASE_URL}/auth/<provider>/callback`. */
  const redirectUri = (provider: ProviderName) => `${baseUrl()}/auth/${provider}/callback`;
  // Handles already used, so a replayed callback is refused even while its cookie is still valid.
  const used = new Map<string, number>();

  const stateCookieOptions = () => ({ ...sessionCookieOptions, secure: env["NODE_ENV"] === "production" || baseUrl().startsWith("https://"), maxAge: 10 * 60 * 1000 });

  function startOAuth(mode: AuthMode) {
    return (req: Request, res: Response) => {
      const provider = String(req.params["provider"]);
      if (!isProvider(provider)) {
        return void sendAuthFailure(req, res, { status: 404, code: "not_found" }, "Unknown provider");
      }
      const unavailable: AuthFailure = { status: 503, code: "not_configured", provider };
      if (!providers[provider].isConfigured()) {
        return void sendAuthFailure(req, res, unavailable, `Sign-in with ${provider === "github" ? "GitHub" : "Google"} is not configured`);
      }
      const secret = env["SESSION_SECRET"];
      if (!secret) return void sendAuthFailure(req, res, unavailable, "Sign-in is not configured");

      const { record, challenge } = newOAuthState({ provider, mode, next: safeNextPath(req.query["next"]) }, now());
      res.cookie(OAUTH_STATE_COOKIE, sealOAuthState(record, secret), stateCookieOptions());
      res.redirect(
        authorizeUrl(provider, { state: record.state, redirectUri: redirectUri(provider), codeChallenge: challenge, nonce: record.nonce }, providers),
      );
    };
  }

  router.get("/auth/:provider/signin", startOAuth("signin"));
  router.get("/auth/:provider/signup", startOAuth("signup"));

  router.get("/auth/:provider/callback", async (req, res) => {
    const provider = String(req.params["provider"]);
    // The state cookie is single-use whatever happens next.
    res.clearCookie(OAUTH_STATE_COOKIE, { ...stateCookieOptions(), maxAge: undefined });

    if (!isProvider(provider)) {
      return void sendAuthFailure(req, res, { status: 404, code: "not_found" }, "Unknown provider");
    }
    if (req.query["error"] !== undefined) {
      // e.g. access_denied: the user declined. Neither the provider's wording nor any other query
      // value is echoed back; the page text is fixed.
      return void sendAuthFailure(req, res, { status: 403, code: "denied", provider }, "Sign-in was cancelled or denied");
    }

    const secret = env["SESSION_SECRET"];
    const code = text(req.query["code"]);
    const state = text(req.query["state"]);
    const saved = secret ? openOAuthState(readCookie(req.headers.cookie, OAUTH_STATE_COOKIE), secret, now()) : null;
    if (!code || !state || !saved || saved.provider !== provider || !sameValue(state, saved.state) || used.has(saved.state)) {
      return void sendAuthFailure(req, res, { status: 400, code: "invalid_state", provider }, "Invalid OAuth callback");
    }
    used.set(saved.state, saved.exp);
    for (const [handle, exp] of used) if (exp < now()) used.delete(handle);

    try {
      const user = await completeOAuth(
        provider,
        saved.mode,
        { code, redirectUri: redirectUri(provider), codeVerifier: saved.verifier, nonce: saved.nonce },
        providers,
      );
      res.cookie(SESSION_COOKIE, createSessionToken(user.id, user.sessionVersion), sessionCookieOptions);
      res.redirect(saved.next);
    } catch (err) {
      sendAuthError(req, res, err, { provider, mode: saved.mode, next: saved.next });
    }
  });

  // ---- Email + password ------------------------------------------------------------------
  // JSON in, JSON out; the session cookie is the same one OAuth sets. The /auth per-IP limit in
  // server/app.ts applies, plus a per-email budget so one account can't be guessed at from many IPs.
  const perEmail = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: (req) => `pw:${normaliseEmail((req.body as Record<string, unknown> | undefined)?.["email"]) ?? "invalid"}`,
  });

  const passwordRoute = (action: (body: Record<string, unknown>) => Promise<User>, status: number) =>
    async (req: Request, res: Response) => {
      if (!env["SESSION_SECRET"]) return void res.status(503).json({ error: "Sign-in is not configured" });
      try {
        const user = await action((req.body ?? {}) as Record<string, unknown>);
        res.cookie(SESSION_COOKIE, createSessionToken(user.id, user.sessionVersion), sessionCookieOptions);
        res.status(status).json({ id: user.id, email: user.email, name: user.name, provider: user.provider, next: safeNextPath((req.body as Record<string, unknown>)?.["next"]) });
      } catch (err) {
        if (err instanceof PasswordAuthError) return void res.status(err.status).json({ error: err.message, code: err.code });
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
      }
    };

  /** POST /auth/password/signup { email, password, name?, next? } -> 201 + session cookie */
  router.post("/auth/password/signup", perEmail, passwordRoute((b) => signUpWithPassword({ email: b["email"], password: b["password"], name: b["name"] }), 201));

  /** POST /auth/password/signin { email, password, next? } -> 200 + session cookie; 401 for any wrong email/password */
  router.post("/auth/password/signin", perEmail, passwordRoute((b) => signInWithPassword({ email: b["email"], password: b["password"] }), 200));

  /**
   * POST /auth/signout: clears the cookie and, when the request carried a valid session, revokes
   * every session of that user (the JWT itself is stateless, so revocation is a version bump).
   * Cross-site requests are rejected earlier by the CSRF middleware in server/security.ts.
   */
  router.post("/auth/signout", async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : readCookie(req.headers.cookie, SESSION_COOKIE);
      const session = verifySession(token);
      const user = session ? await userStore.findById(session.userId) : null;
      if (user && user.sessionVersion === session!.version) await userStore.revokeSessions(user.id);
      res.clearCookie(SESSION_COOKIE, sessionCookieClearOptions);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get(["/profile", "/me"], requireAuth, (req, res) => {
    const { id, email, name, provider } = req.user!;
    res.json({ id, email, name, provider });
  });

  return router;
}

type Context = Pick<AuthFailure, "provider" | "mode" | "next">;

function sendAuthError(req: Request, res: Response, err: unknown, ctx: Context) {
  if (err instanceof AuthError) sendAuthFailure(req, res, { status: err.status, code: err.code, ...ctx }, err.message);
  else if (err instanceof ProviderError) {
    // Operators get the stage and status only: never codes, tokens, secrets or provider bodies.
    console.warn(`OAuth ${err.provider} failure at "${err.stage}"${err.status ? ` (HTTP ${err.status})` : ""}`);
    sendAuthFailure(req, res, { status: 502, code: "provider_error", ...ctx }, err.message);
  } else {
    console.error(err);
    sendAuthFailure(req, res, { status: 500, code: "internal", ...ctx }, "Internal server error");
  }
}

