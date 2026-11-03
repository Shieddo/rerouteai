import { fileURLToPath } from "node:url";
import express from "express";
import { createAuthRouter } from "../auth/authcontroller.ts";
import { assertAuthConfig } from "../auth/config.ts";
import { createDevLoginRouter } from "../auth/devlogin.ts";
import { createProviders } from "../auth/providers.ts";
import { createJourneysRouter } from "../journeys/controller.ts";
import { createDatasetRouter } from "../dataset/controller.ts";
import trainRouter from "../trains/traincontroller.ts";
import { csrfProtection, errorHandler, parseTrustProxy, rateLimit, securityHeaders } from "./security.ts";

type Env = Record<string, string | undefined>;

/** Auth endpoints: sign-in starts, provider callbacks, sign-out. Per client IP. */
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX = 40;
/** Coarse per-IP ceiling in front of the authenticated API; per-user budgets are on the routes. */
const API_WINDOW_MS = 60 * 1000;
const API_IP_MAX = 240;

export function createApp(env: Env = process.env) {
  assertAuthConfig(env);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", parseTrustProxy(env["TRUST_PROXY"]));

  app.use(securityHeaders(env));
  app.use(express.json({ limit: "10kb" }));
  app.use(csrfProtection(env));
  app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url)), { extensions: ["html"] }));

  app.use("/auth", rateLimit({ windowMs: AUTH_WINDOW_MS, max: AUTH_MAX }));
  app.use(["/trains", "/stations", "/journeys", "/profile", "/me", "/plan", "/bookings", "/chat"], rateLimit({ windowMs: API_WINDOW_MS, max: API_IP_MAX }));

  app.use(createDevLoginRouter(env));
  app.use(createAuthRouter({ env, providers: createProviders({ env }) }));
  app.use(trainRouter);
  app.use(createJourneysRouter());
  app.use(createDatasetRouter());

  app.use(errorHandler);
  return app;
}

export default createApp();
