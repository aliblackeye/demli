import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an EAS Build webhook signature.
 *
 * Expo signs the exact raw request body with HMAC-SHA1 using the shared secret
 * set at `eas webhook:create` time, and sends it in the `expo-signature` header
 * formatted as `sha1=<hex digest>`.
 *
 * Source (verified 2026-07): https://docs.expo.dev/eas/webhooks/
 *   const hmac = crypto.createHmac('sha1', SECRET);
 *   hmac.update(req.body);
 *   const hash = `sha1=${hmac.digest('hex')}`;
 *   safeCompare(expoSignature, hash)
 *
 * The comparison is constant-time to avoid leaking the expected digest through
 * timing. `rawBody` MUST be the untouched bytes Expo sent — re-serializing a
 * parsed JSON object would change whitespace/key order and never match.
 */
export function verifyExpoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
  const received = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual throws on length mismatch; a differing length is already a
  // mismatch, so short-circuit before comparing.
  if (received.length !== expectedBuf.length) return false;
  return timingSafeEqual(received, expectedBuf);
}
