/**
 * Baked server endpoints.
 *
 * The shipped APK bakes the live backend URLs at build time via `eas.json`
 * (`EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_REALTIME_URL` -> https://api.getdemli.com,
 * wss://ws.getdemli.com). There is NO in-app override any more — a normal user
 * never configures a server. These two constants ARE the configuration.
 *
 * The fallbacks below only ever apply to a bare local `expo start` with no
 * `.env` present. They point at the LIVE backend so an unconfigured dev run
 * still reaches a working server (the old placeholder LAN IP produced a
 * guaranteed "Can't reach the server" that looked like a production outage).
 * To develop against your own machine, set the LAN URLs in `.env`
 * (see `.env.example`). `clients.ts` and `realtime/connection.ts` read these
 * directly.
 */

/** Fallback for a local run with no EXPO_PUBLIC_* set: the live backend. */
const FALLBACK_API_URL = "https://api.getdemli.com";
const FALLBACK_REALTIME_URL = "wss://ws.getdemli.com";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? FALLBACK_API_URL;
export const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL ?? FALLBACK_REALTIME_URL;
