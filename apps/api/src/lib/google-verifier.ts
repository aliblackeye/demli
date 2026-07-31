import { OAuth2Client } from "google-auth-library";
import type { GoogleIdTokenClaims, GoogleTokenVerifier } from "./google-auth.js";

/**
 * The only module that imports `google-auth-library` (0010). Isolated from the
 * find-or-create/link logic in ./google-auth.ts so that logic stays SDK-free and
 * unit-testable with a mocked {@link GoogleTokenVerifier}.
 */

/** Thrown when a token fails signature/expiry/audience checks or lacks a `sub`. */
export class GoogleTokenVerificationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "GoogleTokenVerificationError";
  }
}

/**
 * Build a verifier that accepts ID tokens whose `aud` is any of `audiences`
 * (the configured web/Android/iOS client IDs). `OAuth2Client.verifyIdToken`
 * validates Google's signature, issuer, expiry, and audience against Google's
 * published certs; anything invalid is surfaced as {@link GoogleTokenVerificationError}.
 */
export function createGoogleTokenVerifier(audiences: string[]): GoogleTokenVerifier {
  const client = new OAuth2Client();
  return {
    async verifyIdToken(idToken: string): Promise<GoogleIdTokenClaims> {
      let payload;
      try {
        const ticket = await client.verifyIdToken({ idToken, audience: audiences });
        payload = ticket.getPayload();
      } catch (err) {
        throw new GoogleTokenVerificationError("Google ID token verification failed.", err);
      }
      if (!payload?.sub) {
        throw new GoogleTokenVerificationError("Google ID token is missing a subject.");
      }
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name,
        picture: payload.picture,
      };
    },
  };
}
