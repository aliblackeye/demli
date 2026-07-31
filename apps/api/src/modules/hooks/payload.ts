/**
 * EAS Build webhook payload shape + the decision logic that gates which builds
 * are allowed to refresh the public APK.
 *
 * Payload fields verified 2026-07 against https://docs.expo.dev/eas/webhooks/ .
 * Only the subset we act on is typed; everything else is ignored. All fields are
 * treated as optional/loose because the body is attacker-influenceable in shape
 * (though not in origin — the HMAC signature is checked first).
 */

export interface EasBuildArtifacts {
  /** Present on successful builds — e.g. https://expo.dev/artifacts/eas/<id>.apk */
  buildUrl?: string;
  /** Newer payloads may carry the archive URL under this name; used as fallback. */
  applicationArchiveUrl?: string;
  logsS3KeyPrefix?: string;
}

export interface EasBuildMetadata {
  appVersion?: string;
  appBuildVersion?: string;
  buildProfile?: string;
  /** EAS Update channel the build targets (e.g. "preview", "production"). */
  channel?: string;
  /** "internal" produces an installable APK; "store" produces an AAB. */
  distribution?: string;
}

export interface EasBuildWebhookPayload {
  id?: string;
  platform?: string; // "android" | "ios"
  status?: string; // "finished" | "errored" | "canceled"
  artifacts?: EasBuildArtifacts;
  metadata?: EasBuildMetadata;
}

/** Channels whose finished Android builds may replace the public APK. */
export const ALLOWED_CHANNELS = new Set(["preview", "production"]);

export type BuildDecision =
  | { process: true; buildUrl: string }
  | { process: false; reason: string };

/**
 * Decide whether a webhook payload should trigger an APK refresh. Only a
 * finished Android build, on an allowed channel (when a channel is present),
 * whose artifact is actually an `.apk`, qualifies. Store builds (`.aab`) and
 * iOS/errored/canceled builds are skipped.
 */
export function evaluateBuild(payload: EasBuildWebhookPayload): BuildDecision {
  if (payload.status !== "finished") {
    return { process: false, reason: `status:${payload.status ?? "unknown"}` };
  }
  if (payload.platform !== "android") {
    return { process: false, reason: `platform:${payload.platform ?? "unknown"}` };
  }

  // Channel is optional (internal-distribution APKs may omit it). Only reject a
  // build that explicitly targets a channel outside the allowlist.
  const channel = payload.metadata?.channel;
  if (channel != null && !ALLOWED_CHANNELS.has(channel)) {
    return { process: false, reason: `channel:${channel}` };
  }

  const buildUrl = payload.artifacts?.buildUrl ?? payload.artifacts?.applicationArchiveUrl;
  if (!buildUrl) {
    return { process: false, reason: "no-artifact-url" };
  }

  // Guard against overwriting the public APK with a store AAB (production store
  // builds ship a `.aab`, not an installable `.apk`).
  if (!/\.apk($|\?)/i.test(buildUrl)) {
    return { process: false, reason: "not-apk" };
  }

  return { process: true, buildUrl };
}

/**
 * SSRF guard: the artifact URL must be an Expo-hosted artifact. Combined with
 * the HMAC check (the payload provably came from Expo), this bounds where the
 * server will issue an outbound GET.
 */
export function isAllowedArtifactUrl(url: string, allowedPrefix: string): boolean {
  return typeof url === "string" && url.startsWith(allowedPrefix);
}
