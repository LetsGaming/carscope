import { randomBytes, createHash } from "node:crypto";

/**
 * Token shape and hashing, kept pure and I/O-free so the auth plugin and the
 * `keys` CLI share one definition — the format can never drift between the
 * process that issues a key and the one that verifies it.
 *
 * 24 bytes of CSPRNG output is 192 bits. There is nothing in that to brute
 * force, so a KDF (bcrypt, argon2) would buy nothing and would need a native
 * module, which this build has no way to compile — it runs straight off
 * TypeScript source via Node's type stripping, with no build step.
 */
const TOKEN_BYTES = 24;
const PREFIX_LEN = 8;
const TOKEN_PREFIX = "csk";

export const SCOPE = { write: "write", admin: "admin" } as const;
export type Scope = (typeof SCOPE)[keyof typeof SCOPE];

export interface IssuedKey {
  /** Shown once at creation. Never stored; only its hash is. */
  readonly token: string;
  /** The non-secret leading part, safe to log and to show in a listing. */
  readonly prefix: string;
  readonly tokenHash: string;
}

/** A freshly generated key, ready to be inserted. */
export function issueKey(): IssuedKey {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const prefix = randomBytes(PREFIX_LEN).toString("hex");
  const token = `${TOKEN_PREFIX}_${prefix}_${secret}`;
  return { token, prefix, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A key with no scopes is read-only: it exists only to lift its rate tier. */
export function parseScopes(stored: string): ReadonlySet<Scope> {
  const known = new Set<string>(Object.values(SCOPE));
  return new Set(stored.split(",").map((s) => s.trim()).filter((s) => known.has(s)) as Scope[]);
}

export function scopesToColumn(scopes: readonly Scope[]): string {
  return scopes.join(",");
}

/** `admin` implies `write`; nothing else does. */
export function hasScope(granted: ReadonlySet<Scope>, required: Scope): boolean {
  return granted.has(required) || (required === SCOPE.write && granted.has(SCOPE.admin));
}
