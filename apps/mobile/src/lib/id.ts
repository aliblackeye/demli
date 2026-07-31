/**
 * Message-nonce / id generator for the realtime glue.
 *
 * React Native (Hermes) has no `crypto.randomUUID`, so client-core's
 * `defaultIdGenerator` would silently fall back to a non-crypto id. We instead
 * pass a proper UUID from `expo-crypto` (an injectable {@link IdGenerator} —
 * exactly the seam ADR 0002 describes).
 */
import * as Crypto from "expo-crypto";
import type { IdGenerator } from "@demli/client-core";

export const newId: IdGenerator = () => Crypto.randomUUID();
