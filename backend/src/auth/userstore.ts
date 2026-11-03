import type { ProviderName } from "./providers.ts";

/**
 * OAuth providers, "password" (email + password accounts, providerId = normalised email) and
 * "dev", which only the development login (devlogin.ts) ever uses.
 */
export type UserProvider = ProviderName | "password" | "dev";

/** Raised by `create` when that provider identity already has a user. */
export class DuplicateUserError extends Error {
  constructor() {
    super("A user with this provider identity already exists");
  }
}

export type User = {
  id: number;
  email: string;
  name: string | null;
  provider: UserProvider;
  providerId: string;
  /** Raised by sign-out; session tokens carrying an older version are no longer accepted. */
  sessionVersion: number;
};

/** A user is identified by (provider, providerId); email is informational and never used to link accounts. */
export type UserStore = {
  findByProvider(provider: UserProvider, providerId: string): Promise<User | null>;
  findById(id: number): Promise<User | null>;
  /** `passwordHash` only for provider "password"; it is stored apart from the User object. */
  create(data: Omit<User, "id" | "sessionVersion">, options?: { passwordHash?: string }): Promise<User>;
  /** The stored password hash, or null for accounts without a password (OAuth, dev). */
  getPasswordHash(id: number): Promise<string | null>;
  /** Invalidates every session token issued so far for this user (sign out everywhere). */
  revokeSessions(id: number): Promise<void>;
};

export function createMemoryUserStore(): UserStore {
  const users: User[] = [];
  const hashes = new Map<number, string>();
  return {
    async findByProvider(provider, providerId) {
      return users.find((u) => u.provider === provider && u.providerId === providerId) ?? null;
    },
    async findById(id) {
      return users.find((u) => u.id === id) ?? null;
    },
    async create(data, options) {
      if (users.some((u) => u.provider === data.provider && u.providerId === data.providerId)) {
        throw new DuplicateUserError();
      }
      const user = { id: users.length + 1, sessionVersion: 0, ...data };
      users.push(user);
      if (options?.passwordHash) hashes.set(user.id, options.passwordHash);
      return user;
    },
    async getPasswordHash(id) {
      return hashes.get(id) ?? null;
    },
    async revokeSessions(id) {
      const i = users.findIndex((u) => u.id === id);
      if (i >= 0) users[i] = { ...users[i]!, sessionVersion: users[i]!.sessionVersion + 1 };
    },
  };
}

/**
 * PostgreSQL unless USER_STORE=memory. There is no silent fallback: a missing DATABASE_URL is an
 * error, because users that quietly vanish on restart are worse than a server that complains.
 * `bun test` selects the memory store in test/setup.ts, so unit tests never touch a database.
 */
export function selectUserStore(env: Record<string, string | undefined> = process.env): () => Promise<UserStore> {
  let store: Promise<UserStore> | undefined;
  return () =>
    (store ??= (async () => {
      if (env["USER_STORE"] === "memory") return createMemoryUserStore();
      const url = env["DATABASE_URL"];
      if (!url) throw new Error("DATABASE_URL is not set (or set USER_STORE=memory for throwaway in-memory users)");
      const { createPostgresUserStore } = await import("./postgresuserstore.ts");
      return createPostgresUserStore(new Bun.SQL(url, { max: 5 }));
    })());
}

const resolve = selectUserStore();

/** Resolves the real store on first use, so importing this module never connects to anything. */
export const userStore: UserStore = {
  findByProvider: async (provider, providerId) => (await resolve()).findByProvider(provider, providerId),
  findById: async (id) => (await resolve()).findById(id),
  create: async (data, options) => (await resolve()).create(data, options),
  getPasswordHash: async (id) => (await resolve()).getPasswordHash(id),
  revokeSessions: async (id) => (await resolve()).revokeSessions(id),
};
