/**
 * Expo config plugin: inject `LiveKitReactNative.setup(this)` into the Android
 * MainApplication.onCreate.
 *
 * Why this exists: `@livekit/react-native` needs its native audio device module
 * initialized in Application.onCreate. Without it, the FIRST time a Room opens an
 * audio track the WebRTC module throws
 *   "Audio device module is not initialized! Did you remember to call
 *    LiveKitReactNative.setup in your Application.onCreate?"
 * which tears down the whole React tree (black screen) — every voice-channel join
 * crashed. `registerGlobals()` (JS) is not enough; this is a native-side call.
 *
 * `@livekit/react-native-expo-plugin@1.0.2` only writes AndroidManifest meta-data
 * and does NOT touch the SDK 57 Kotlin MainApplication, so we do the injection
 * ourselves. `setup()` is idempotent, so this is safe alongside the official
 * plugin. Kotlin + Java MainApplication both handled.
 */
const { withMainApplication } = require("expo/config-plugins");

const IMPORT_KT = "import com.livekit.reactnative.LiveKitReactNative";
const SETUP_KT = "    LiveKitReactNative.setup(this)";

/** @param {string} src @returns {string} */
function addImportKotlin(src) {
  if (src.includes(IMPORT_KT)) return src;
  // Insert the import after the package declaration.
  return src.replace(/(^package .*$)/m, `$1\n\n${IMPORT_KT}`);
}

/** @param {string} src @returns {string} */
function addSetupKotlin(src) {
  if (src.includes("LiveKitReactNative.setup(")) return src;
  // Call setup() as the first statement after super.onCreate() so the audio
  // device module is ready before React (and any Room) starts.
  return src.replace(
    /(override fun onCreate\(\) \{\s*\n\s*super\.onCreate\(\)\n)/,
    `$1${SETUP_KT}\n`,
  );
}

module.exports = function withLiveKitSetup(config) {
  return withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== "kt") {
      throw new Error(
        "[with-livekit-setup] expected a Kotlin MainApplication; got " +
          cfg.modResults.language,
      );
    }
    let src = cfg.modResults.contents;
    src = addImportKotlin(src);
    src = addSetupKotlin(src);
    cfg.modResults.contents = src;
    return cfg;
  });
};
