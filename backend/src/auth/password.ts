// Email + password accounts. They are a third kind of identity next to GitHub and Google:
// provider "password", providerId = the normalised email. Like the OAuth providers, accounts are
// never linked by email, so a GitHub account and a password account with the same address are
// separate users.
//
// Passwords are hashed with argon2id (Bun.password) and stored apart from the User object, so a
// hash never travels with a user through the app. Sign-in failures share one message and the same
// work (a dummy verify when the email is unknown), so responses don't reveal which emails exist.

import { DuplicateUserError, userStore, type User } from "./userstore.ts";

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const EMAIL_MAX = 254;
const NAME_MAX = 80;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PasswordAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "invalid_input" | "account_exists" | "invalid_credentials",
  ) {
    super(message);
  }
}

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX && EMAIL.test(email) ? email : null;
}

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required";
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Password must contain at least one letter and one number";
  return null;
}

const hash = (password: string) => Bun.password.hash(password, { algorithm: "argon2id" });

let dummyHash: Promise<string> | null = null;
/** Burns the same verify time as a real check, for emails that have no account. */
async function dummyVerify(password: string) {
  dummyHash ??= hash("reroute-dummy-password-0");
  await Bun.password.verify(password, await dummyHash);
}

export async function signUpWithPassword(input: { email: unknown; password: unknown; name?: unknown }): Promise<User> {
  const email = normaliseEmail(input.email);
  if (!email) throw new PasswordAuthError("Enter a valid email address", 400, "invalid_input");
  const problem = passwordProblem(input.password);
  if (problem) throw new PasswordAuthError(problem, 400, "invalid_input");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, NAME_MAX) : null;

  if (await userStore.findByProvider("password", email)) {
    throw new PasswordAuthError("An account with this email already exists. Sign in instead.", 409, "account_exists");
  }
  try {
    return await userStore.create({ email, name, provider: "password", providerId: email }, { passwordHash: await hash(input.password as string) });
  } catch (err) {
    // Two simultaneous sign-ups for one email: the unique key picks the winner.
    if (err instanceof DuplicateUserError) throw new PasswordAuthError("An account with this email already exists. Sign in instead.", 409, "account_exists");
    throw err;
  }
}

const INVALID = () => new PasswordAuthError("Incorrect email or password", 401, "invalid_credentials");

export async function signInWithPassword(input: { email: unknown; password: unknown }): Promise<User> {
  const email = normaliseEmail(input.email);
  const password = typeof input.password === "string" && input.password.length <= PASSWORD_MAX ? input.password : null;
  if (!email || !password) throw INVALID();

  const user = await userStore.findByProvider("password", email);
  const stored = user ? await userStore.getPasswordHash(user.id) : null;
  if (!user || !stored) {
    await dummyVerify(password);
    throw INVALID();
  }
  if (!(await Bun.password.verify(password, stored))) throw INVALID();
  return user;
}
