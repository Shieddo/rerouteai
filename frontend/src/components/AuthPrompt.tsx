"use client";

// Sign-in and sign-up choices shown when the API answers 401, and on /signin. Email + password
// posts to /auth/password/*; GitHub and Google are plain links into the backend's OAuth flow
// (/auth/<provider>/<signin|signup>), which owns state, PKCE and validation.

import { useId, useState } from "react";
import { safeNext } from "@/config/routes";
import { passwordAuth } from "@/lib/api";

type Provider = "github" | "google";
export type Mode = "signin" | "signup";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
];

/** `next` brings the user back to the page they were on. */
export const authHref = (provider: Provider, mode: Mode, next?: string) =>
  `/auth/${provider}/${mode}${next ? `?next=${encodeURIComponent(next)}` : ""}`;

export function PasswordForm({ next, initialMode = "signin" }: { next?: string; initialMode?: Mode }) {
  const id = useId();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signup = mode === "signup";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (signup && (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))) {
      return setError("Use at least 8 characters with a letter and a number.");
    }
    setBusy(true);
    const outcome = await passwordAuth(mode, { email, password, ...(signup && name.trim() && { name: name.trim() }) });
    if (outcome.kind === "ok") {
      // Full navigation so the header and every page pick up the new session.
      window.location.assign(safeNext(next ?? window.location.pathname));
      return;
    }
    setBusy(false);
    setError(outcome.message);
  }

  return (
    <form className="password-form" onSubmit={(e) => void submit(e)} noValidate>
      <div className="segmented" role="tablist" aria-label="Email sign-in mode">
        {(["signin", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "is-active" : ""}
            onClick={() => {
              setMode(m);
              setError("");
            }}
          >
            {m === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>
      {signup && (
        <div>
          <label htmlFor={`${id}-name`}>Name (optional)</label>
          <input id={`${id}-name`} autoComplete="name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      <div>
        <label htmlFor={`${id}-email`}>Email</label>
        <input id={`${id}-email`} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          required
          minLength={signup ? 8 : undefined}
          maxLength={128}
          value={password}
          aria-describedby={signup ? `${id}-hint` : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
        {signup && (
          <p className="station-meta" id={`${id}-hint`}>
            At least 8 characters, with a letter and a number.
          </p>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !email || !password}>
        {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}

/** Full-page auth card for /signin and /signup: email form plus OAuth buttons for the given mode. */
export function AuthCard({ mode, next }: { mode: Mode; next?: string }) {
  const signup = mode === "signup";
  return (
    <div className="auth-card">
      <h1>{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="lede">{signup ? "Start booking confirmed seats in under a minute." : "Sign in to book seats, manage tickets and chat with the assistant."}</p>
      <div className="oauth-row">
        {PROVIDERS.map(({ id, label }) => (
          <a key={id} href={authHref(id, mode, next)} className="button secondary">
            {signup ? "Sign up" : "Continue"} with {label}
          </a>
        ))}
      </div>
      <p className="divider">
        <span>or use email</span>
      </p>
      <PasswordForm key={mode} next={next} initialMode={mode} />
      <p className="auth-switch">
        {signup ? "Already have an account?" : "New to Reroute?"}{" "}
        <a href={`${signup ? "/signin" : "/signup"}${next ? `?next=${encodeURIComponent(next)}` : ""}`}>{signup ? "Sign in" : "Create an account"}</a>
      </p>
    </div>
  );
}

export function AuthPrompt({ next }: { next?: string }) {
  return (
    <section id="auth-prompt" className="cad auth-prompt" aria-label="Sign in or sign up">
      <div className="auth-group">
        <h3>Email and password</h3>
        <p>Sign in, or create an account in seconds.</p>
        <PasswordForm next={next} />
      </div>
      <div className="auth-group">
        <h3>Or continue with</h3>
        <p>Use the provider you signed up with, or create your account with it.</p>
        <div className="auth-links">
          {PROVIDERS.map(({ id: provider, label }) => (
            // Full-page navigation on purpose: this is a redirect flow, not a client route.
            <a key={provider} href={authHref(provider, "signin", next)} className="button">
              Sign in with {label}
            </a>
          ))}
          {PROVIDERS.map(({ id: provider, label }) => (
            <a key={`up-${provider}`} href={authHref(provider, "signup", next)} className="button secondary">
              Sign up with {label}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
