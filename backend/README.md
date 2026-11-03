# backend

Express API for Reroute, run with [Bun](https://bun.com).

```bash
bun install
cp .env.example .env   # set DATABASE_URL and SESSION_SECRET
bun run db:migrate     # once per database: creates the users and saved_journeys tables (additive, idempotent)
bun run dev            # hot reload, http://localhost:8000
bun run start
```

## Email and password accounts

Besides GitHub and Google, people can create an account with an email and password:

| | |
| --- | --- |
| Sign up | `POST /auth/password/signup` `{ email, password, name? }` → 201 + session cookie (409 if the email already has a password account) |
| Sign in | `POST /auth/password/signin` `{ email, password }` → 200 + session cookie; 401 "Incorrect email or password" for any wrong email or password |

Passwords need 8–128 characters with a letter and a number and are stored as argon2id hashes (`Bun.password`) in `users.password_hash` (added by `bun run db:migrate`; additive). Emails are trimmed and lower-cased; they are not verified (no email is sent). Password accounts are never merged with a GitHub or Google account that uses the same address. Sign-in is rate limited per IP (the `/auth` limit) and per email (10 per 15 minutes).

## Development login (local only)

Signs you in as a fixed "Development User" so you can use authenticated pages without GitHub or Google OAuth. It uses the normal session cookie and `requireAuth`, so protected routes behave exactly as they do for real users.

1. In `.env`, set a signing key and the flag (the key can be any random string):
   ```bash
   SESSION_SECRET="<output of: openssl rand -hex 32>"
   DEV_LOGIN="true"
   ```
2. Start the app: `bun run dev`. The console prints a `DEV_LOGIN is enabled` warning.
3. Open <http://localhost:8000/auth/dev/login>. You are redirected to `/search` signed in. Add `?next=/profile` to land on another path of this site.
4. To turn it off, remove `DEV_LOGIN` (or set it to anything other than exactly `true`) and restart. The route then returns 404.

Safeguards: it is off unless `DEV_LOGIN` is exactly `true`; the server refuses to start if it is enabled while `NODE_ENV=production`; it only answers requests from the local machine; and it ignores any user id or email in the request. It never reads or issues anything other than the single dev user's session. Don't set `DEV_LOGIN` on any deployed environment.

The users are held in memory, so restarting the server signs you out (the cookie then points at a user that no longer exists); visit the login URL again.

## User storage

Users are stored in PostgreSQL (`users` table, via Bun's built-in `Bun.SQL`), keyed by `(provider, provider_id)`. Email is not unique and is never used to link accounts, so the same address signing in with GitHub and with Google gives two separate users.

- `bun run db:migrate` creates the table if missing. It only ever adds; it never alters or drops data.
- `DATABASE_URL` is required. If it is missing the server errors on first use rather than quietly keeping users in memory. `USER_STORE=memory` opts in to throwaway in-memory users.
- `bun test` always uses the in-memory store and ignores `DATABASE_URL`. To also run the PostgreSQL store tests, point `TEST_DATABASE_URL` at a database you are happy to create a scratch table in (each run creates and drops its own `users_test_<random>` table and never touches `users`):
  ```bash
  TEST_DATABASE_URL="postgresql://..." bun test src/auth/userstore.test.ts
  ```
- Prisma is not used for users yet: with the pinned prerelease packages `prisma contract emit` fails (even on the untouched contract), which is also why `src/prisma/db.ts` does not typecheck.

## OAuth setup (GitHub and Google)

Sign-in uses the authorization-code flow with PKCE and a signed, expiring, single-use state cookie. Accounts are identified only by the provider's stable user id, never by email, so the same address on GitHub and on Google gives two separate users.

**Routes** (from `src/auth/authcontroller.ts`):

| Purpose | Path |
|---|---|
| Start sign-in / sign-up | `GET /auth/github/signin`, `/auth/github/signup`, `/auth/google/signin`, `/auth/google/signup` (optional `?next=/path`, same-site paths only, default `/search`) |
| Provider callback | `GET /auth/github/callback`, `GET /auth/google/callback` |

The callback URL you register with each provider is `${BASE_URL}/auth/<provider>/callback`:

| | GitHub | Google |
|---|---|---|
| Local development (`BASE_URL=http://localhost:8000`, the default) | `http://localhost:8000/auth/github/callback` | `http://localhost:8000/auth/google/callback` |
| Production (`BASE_URL=https://<your-domain>`) | `https://<your-domain>/auth/github/callback` | `https://<your-domain>/auth/google/callback` |

If you change `PORT`, change `BASE_URL` to match, then register the new URL. The URL must match exactly, including scheme, host, port and path.

**GitHub** — github.com → Settings → Developer settings → OAuth Apps → New OAuth App. Set *Homepage URL* to `BASE_URL` and *Authorization callback URL* to the GitHub URL above. Generate a client secret. GitHub allows one callback URL per app, so create one app for local development and one for production. Put the values in `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Reroute requests `read:user user:email` and only trusts an email GitHub reports as verified.

**Google** — console.cloud.google.com → APIs & Services → OAuth consent screen (configure it; add yourself as a test user while in testing), then Credentials → Create credentials → OAuth client ID → *Web application*. Add the Google URL above under *Authorized redirect URIs* (add both the local and the production URL to one client if you like). Put the values in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Reroute requests `openid email profile`, verifies the ID token (RS256 signature against Google's published keys, issuer, audience, expiry, nonce) and requires `email_verified` to create an account.

**Also required:** `SESSION_SECRET` (e.g. `openssl rand -hex 32`) and a database (`DATABASE_URL`, `bun run db:migrate`). A provider with no id or secret answers `503 not configured`. In production (`NODE_ENV=production`) the server refuses to start unless `SESSION_SECRET` is 32+ characters and not a placeholder, and `BASE_URL` is `https://`.

**Try it:** `bun run dev`, open `http://localhost:8000/auth/github/signup` (first time) and approve; you land on `/search` signed in. Later visits use `/auth/github/signin`. A sign-in for an account that was never signed up returns 404 "No account found, sign up first".

Automated tests mock every provider HTTP call. A real GitHub or Google sign-in has not been run against this implementation.

## Security and deployment notes

- **Sessions** are HS256 JWTs (7 days) in an HttpOnly, SameSite=Lax, `Secure`-on-https cookie. Signing out (`POST /auth/signout`) revokes **every** session of that user by bumping `users.session_version`; tokens carrying an older version are refused. Run `bun run db:migrate` **before** deploying a version that needs the column (it is additive and keeps existing users).
- **CSRF:** cookie-authenticated `POST/PUT/PATCH/DELETE` requests must carry an `Origin` (or `Referer`) equal to `BASE_URL` (outside production also the server's own host:port), and are refused when `Sec-Fetch-Site: cross-site`. Requests with no session cookie or an explicit `Authorization: Bearer` header are not affected, and GETs are never checked. OAuth callbacks are protected by the signed, single-use state cookie instead.
- **Rate limits** (in-process memory): auth endpoints 40 per 10 min per IP; the authenticated API 240/min per IP, and per user 30/min `/trains/search`, 60/min `/trains/alternatives`, 120/min `/stations/search`. Behind a reverse proxy set `TRUST_PROXY` to the number of proxy hops, otherwise all clients share the proxy's IP; with several server instances each keeps its own counters, so the real ceiling is `limit x instances` (use a shared store such as Redis if that matters).
- **Headers:** CSP (`default-src 'self'`, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, referrer policy, HSTS for https production, `no-store` on account and API responses. **CORS is deliberately not enabled**: the API is same-origin only.
- **Production startup** refuses to run without a 32+ character non-placeholder `SESSION_SECRET`, an `https://` `BASE_URL`, `DATABASE_URL`, and with `DEV_LOGIN=true` or `USER_STORE=memory`. It warns when no OAuth provider, `RAILRADAR_API_KEY` or `TRUST_PROXY` is configured.
- **Errors:** clients only see fixed messages; SQL, driver, stack and RailRadar details stay in the server log.
- The server speaks plain HTTP: terminate TLS at a reverse proxy or platform load balancer.

## Saved journeys

Signed-in users can save a journey from the search results and manage them under **Saved journeys** (`/search#saved`). The owner is always the user in the verified session; nothing the client sends can name another owner.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /journeys/saved` | `{ "journey": <Journey> }`, exactly as returned by `/trains/alternatives` | `201 { "journey": SavedJourney }`, or `200` with the existing one if that trip is already saved | `400 { error }` invalid payload, `401`, `409 { error, code: "LIMIT_REACHED" }` (100 per user), `413`, `429` |
| `GET /journeys/saved` | none | `200 { "journeys": SavedJourney[] }`, newest first, only the caller's | `401`, `429` |
| `DELETE /journeys/saved/:id` | none | `204` | `404 { error }` for an unknown id **and** for another user's journey (indistinguishable), `401`, `429` |

`SavedJourney` is `{ id, savedAt, source, destination, travelDate, journey }` (see `src/journeys/types.ts`). The journey is validated field by field and checked for consistency (legs connect, time moves forward, totals agree); unknown fields are dropped. It is a snapshot of what the user was shown, not a booking and not re-checked against the timetable.

Storage is the `saved_journeys` table (`bun run db:migrate`; additive, never touches `users`): UUID id, `user_id` with `ON DELETE CASCADE`, source/destination, travel date, departure/arrival, transfer count and duration, the full journey as `jsonb` (legs, transfers, warnings), `created_at`, `UNIQUE (user_id, journey_key)` so the same trip is stored once, `CHECK` constraints on shape and size, and an index on `(user_id, created_at DESC)`. Per-user budgets: 30 saves, 120 lists and 60 deletes per minute. CSRF, headers and the 10 KB body limit apply as for the rest of the API.

PostgreSQL tests are opt-in: `TEST_DATABASE_URL="postgresql://..." bun test src/journeys` (each run creates and drops its own scratch `users_jtest_*` and `saved_jtest_*` tables and never touches real data). Without it those tests are reported as skipped.
