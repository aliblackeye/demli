import type { FastifyInstance } from "fastify";
import { errorBody } from "../../errors.js";
import {
  DEFAULT_MAX_APK_BYTES,
  downloadApkToFile,
  type DownloadApkOptions,
  type DownloadResult,
} from "./download.js";
import { evaluateBuild, isAllowedArtifactUrl, type EasBuildWebhookPayload } from "./payload.js";
import { verifyExpoSignature } from "./signature.js";

const ROUTE = "/hooks/eas-build";

export interface HooksModuleOptions {
  /**
   * Injectable APK downloader — tests supply a stub to assert scheduling without
   * touching the network or filesystem. Production uses the real streamer.
   */
  downloadApk?: (options: DownloadApkOptions) => Promise<DownloadResult>;
}

/**
 * EAS Build webhook receiver (task #39). On a finished Android build, refreshes
 * the fixed public APK at `<APK_OUTPUT_DIR>/demli.apk` so the stable download
 * link always points at the latest build — no manual curl.
 *
 * Disabled (route NOT registered → 404) unless `EAS_WEBHOOK_SECRET` is set, so
 * the endpoint is invisible when the feature is off and no unsigned request is
 * ever processed. When enabled:
 *   1. Verify Expo's HMAC-SHA1 over the raw body        → 401 on mismatch
 *   2. Skip non-android / non-finished / non-apk builds → 200 { skipped }
 *   3. Reject artifact URLs outside the Expo prefix     → 200 { skipped }
 *   4. Ack immediately, refresh the APK in the background → 200 { accepted }
 *
 * Steps 2-4 always answer 200 so a downstream write error never makes Expo retry
 * (its delivery timeout is short and retries would stampede).
 */
export async function registerHooksModule(
  server: FastifyInstance,
  options: HooksModuleOptions = {},
): Promise<void> {
  const secret = server.apiEnv.easWebhookSecret;
  if (!secret) {
    server.log.info("[eas-webhook] EAS_WEBHOOK_SECRET unset — webhook disabled");
    return;
  }

  const outputDir = server.apiEnv.apkOutputDir;
  const allowedPrefix = server.apiEnv.easArtifactUrlPrefix;
  const downloadApk = options.downloadApk ?? downloadApkToFile;

  // Encapsulated child scope: the raw-buffer content-type parser below is scoped
  // to this plugin (Fastify parsers respect encapsulation), so every other route
  // keeps normal parsed-JSON bodies while this one gets the exact bytes to HMAC.
  await server.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    scope.post(
      ROUTE,
      {
        // The webhook body is small JSON; the APK is fetched separately.
        bodyLimit: 1_000_000,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const rawBody = request.body as Buffer;
        const header = request.headers["expo-signature"];
        const signature = Array.isArray(header) ? header[0] : header;

        if (!verifyExpoSignature(rawBody, signature, secret)) {
          return reply.status(401).send(errorBody("UNAUTHORIZED", "Invalid signature."));
        }

        let payload: EasBuildWebhookPayload;
        try {
          payload = JSON.parse(rawBody.toString("utf8")) as EasBuildWebhookPayload;
        } catch {
          return reply.status(200).send({ ok: true, skipped: "invalid-json" });
        }

        const decision = evaluateBuild(payload);
        if (!decision.process) {
          request.log.info(`[eas-webhook] skip build ${payload.id ?? "?"}: ${decision.reason}`);
          return reply.status(200).send({ ok: true, skipped: decision.reason });
        }

        if (!isAllowedArtifactUrl(decision.buildUrl, allowedPrefix)) {
          request.log.warn(`[eas-webhook] rejected artifact url for build ${payload.id ?? "?"}`);
          return reply.status(200).send({ ok: true, skipped: "forbidden-artifact-url" });
        }

        // Ack now; refresh in the background. Any failure is logged inside the
        // downloader and swallowed here so Expo never sees a 5xx and retries.
        void downloadApk({
          url: decision.buildUrl,
          outputDir,
          allowedPrefix,
          maxBytes: DEFAULT_MAX_APK_BYTES,
          log: (message) => request.log.info(message),
        }).catch((err: unknown) => {
          request.log.error(`[eas-webhook] apk refresh crashed: ${(err as Error).message}`);
        });

        return reply.status(200).send({ ok: true, accepted: payload.id });
      },
    );
  });
}
