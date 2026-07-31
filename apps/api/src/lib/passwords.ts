import argon2 from "argon2";

/**
 * Password hashing — argon2id with library defaults (memory-hard, per-hash
 * salt). Founder-decision note: username+password is the pragmatic MVP auth;
 * magic link / OAuth remains open for revisit (CLAUDE.md §28/§33).
 */

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
