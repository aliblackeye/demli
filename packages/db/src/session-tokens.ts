/**
 * Opaque session token helpers, shared by the API (issues tokens) and the
 * realtime gateway (validates tokens on the WebSocket handshake).
 *
 * The raw token goes to the client; only its SHA-256 hash is persisted, so a
 * leaked database dump cannot be replayed as bearer tokens.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits of entropy, base64url — safe for headers and query strings. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionExpiresAt(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

export function isSessionExpired(expiresAt: string | Date, now: Date): boolean {
  const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  return t <= now.getTime();
}

/** Constant-time comparison of two token hashes. */
export function tokenHashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
