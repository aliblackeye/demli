/**
 * Expo config plugin: declare the `@supersami/rn-foreground-service` Android
 * services + notification-channel meta-data so a voice session can keep the
 * microphone AND the camera alive in the background.
 *
 * Why this exists: Android silences the mic and freezes the camera when the app
 * stops being visible unless a foreground service is running whose type covers
 * that capability — and types do not cross-grant, so the screen share's
 * `mediaProjection` service covers neither. The library ships NO manifest
 * service declarations of its own (its postinstall patches a bare-RN `android/`
 * folder, which Expo CNG regenerates from scratch), so we inject them here at
 * prebuild:
 *   - ForegroundService     — the foreground service, tagged `microphone|camera`.
 *   - ForegroundServiceTask — the headless-task runner the service loops on.
 * We also add the notification-channel name/description meta-data the library's
 * NotificationConfig reads (a null channel name would otherwise create a
 * nameless channel). Static strings — no color/resource dependency (the accent
 * color is passed from JS at start()).
 *
 * The manifest type is the CEILING; the RUNTIME type passed to startForeground
 * is chosen per-session in src/media/foreground-service.ts and only includes
 * `camera` while the camera is actually on, because requesting a type whose
 * permission was never granted makes startForeground throw.
 *
 * Required permissions (FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE,
 * FOREGROUND_SERVICE_CAMERA, POST_NOTIFICATIONS) live in app.json. Idempotent —
 * re-running the plugin never duplicates entries.
 */
const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

const SERVICE = "com.supersami.foregroundservice.ForegroundService";
const SERVICE_TASK = "com.supersami.foregroundservice.ForegroundServiceTask";
const META_CHANNEL_NAME =
  "com.supersami.foregroundservice.notification_channel_name";
const META_CHANNEL_DESCRIPTION =
  "com.supersami.foregroundservice.notification_channel_description";

/** @param {string} name */
const isOurService = (name) => name === SERVICE || name === SERVICE_TASK;
/** @param {string} name */
const isOurMeta = (name) =>
  name === META_CHANNEL_NAME || name === META_CHANNEL_DESCRIPTION;

/**
 * The RUNTIME foreground-service types the manifest must permit. This string is
 * the ceiling Android enforces on `startForeground`: a runtime type outside it
 * throws, so dropping `camera` here silently freezes the camera of every
 * backgrounded video call. Exported so a unit test can assert it without a
 * prebuild (see src/media/foreground-service.test.ts).
 */
const FOREGROUND_SERVICE_TYPE = "microphone|camera";

/**
 * The pure manifest mutation, split out from the plugin wrapper so it is
 * testable directly against a plain `<application>` object — no Expo prebuild,
 * no Android SDK. Mutates and returns `app`.
 *
 * @param {{ service?: unknown[], "meta-data"?: unknown[] }} app
 */
function applyForegroundServiceManifest(app) {
  // Services (idempotent). ForegroundService carries the microphone + camera
  // types (a call keeps both capturing in the background);
  // ForegroundServiceTask is a plain headless-task service (no type needed).
  app.service = (app.service ?? []).filter(
    (s) => !isOurService(s?.$?.["android:name"]),
  );
  app.service.push({
    $: {
      "android:name": SERVICE,
      "android:exported": "false",
      "android:foregroundServiceType": FOREGROUND_SERVICE_TYPE,
    },
  });
  app.service.push({
    $: {
      "android:name": SERVICE_TASK,
      "android:exported": "false",
    },
  });

  // Notification-channel meta-data (idempotent). Static, localized-neutral
  // strings; the visible notification title/body come from JS via i18n.
  app["meta-data"] = (app["meta-data"] ?? []).filter(
    (m) => !isOurMeta(m?.$?.["android:name"]),
  );
  app["meta-data"].push({
    $: { "android:name": META_CHANNEL_NAME, "android:value": "Sesli oturum" },
  });
  app["meta-data"].push({
    $: {
      "android:name": META_CHANNEL_DESCRIPTION,
      "android:value": "Sesli odada arka planda konuşmayı sürdürür.",
    },
  });

  return app;
}

function withForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    applyForegroundServiceManifest(
      AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults),
    );
    return cfg;
  });
}

module.exports = withForegroundService;
// Test seams — the manifest is native config no JS test can otherwise reach.
module.exports.applyForegroundServiceManifest = applyForegroundServiceManifest;
module.exports.FOREGROUND_SERVICE_TYPE = FOREGROUND_SERVICE_TYPE;
module.exports.SERVICE = SERVICE;
