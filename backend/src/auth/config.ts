type Env = Record<string, string | undefined>;

const PLACEHOLDERS = new Set(["change-me", "changeme", "secret", "password"]);

const isProduction = (env: Env) => env["NODE_ENV"]?.trim().toLowerCase() === "production";

/**
 * In production the server must not start with a missing or guessable signing key, a non-HTTPS
 * public URL, no database, or throwaway in-memory users. (The development login is refused
 * separately in devlogin.ts.) Soft problems are logged as warnings instead.
 */
export function assertAuthConfig(env: Env = process.env) {
  if (!isProduction(env)) return;

  const secret = env["SESSION_SECRET"] ?? "";
  if (secret.length < 32 || PLACEHOLDERS.has(secret.toLowerCase())) {
    throw new Error("Refusing to start: SESSION_SECRET must be a random string of at least 32 characters in production");
  }
  const base = env["BASE_URL"] ?? "";
  if (!base.startsWith("https://")) {
    throw new Error("Refusing to start: BASE_URL must be the public https:// URL of this server in production");
  }
  if (env["USER_STORE"] === "memory") {
    throw new Error("Refusing to start: USER_STORE=memory would lose every account on restart; use PostgreSQL in production");
  }
  if (!env["DATABASE_URL"]) {
    throw new Error("Refusing to start: DATABASE_URL must be set in production");
  }

  const github = !!env["GITHUB_CLIENT_ID"] && !!env["GITHUB_CLIENT_SECRET"];
  const google = !!env["GOOGLE_CLIENT_ID"] && !!env["GOOGLE_CLIENT_SECRET"];
  if (!github && !google) console.warn("No OAuth provider is configured: only email + password sign-in is available");
  if (!env["GROQ_API_KEY"]) console.warn("GROQ_API_KEY is not set: the AI ticket assistant will answer 503");
  if (!env["TRUST_PROXY"]) {
    console.warn("TRUST_PROXY is not set: behind a reverse proxy every client will share the proxy's IP for rate limiting");
  }
}
