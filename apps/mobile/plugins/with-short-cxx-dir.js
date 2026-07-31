const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Windows MAX_PATH escape hatch for the NDK build.
 *
 * CMake writes object files whose name EMBEDS the absolute source path, under
 * the module's `.cxx` directory:
 *
 *   <repo>/apps/mobile/android/app/.cxx/RelWithDebInfo/<hash>/arm64-v8a/
 *     rngesturehandler_codegen_autolinked_build/CMakeFiles/
 *     react_codegen_rngesturehandler_codegen.dir/
 *     C_/<repo>/node_modules/react-native-gesture-handler/shared/shadowNodes/
 *     react/renderer/components/rngesturehandler_codegen/
 *     RNGestureHandlerDetectorShadowNode.cpp.o
 *
 * That is ~240 characters BEFORE the repo path is counted twice, and the APIs
 * ninja and CMake use still cap at 260. Measured 2026-07-31: from `C:\teamcord`
 * (11 chars) this builds; from `C:\projects\demli` (17 chars) the same commit
 * dies with `ninja: error: Stat(...): Filename longer than 260 characters`.
 *
 * A directory junction does NOT help — AGP canonicalises the path back to the
 * real one before handing it to CMake, so the short alias never reaches ninja.
 *
 * What does help is moving the staging directory itself off the deep path.
 * `buildStagingDirectory` is the one knob AGP exposes for it, and pointing it
 * at a short absolute path removes ~46 characters from every object file.
 *
 * Only on Windows, and only when the caller asks: DEMLI_CXX_DIR must be set (the
 * build script sets it). On Linux/macOS, and on any machine that has not opted
 * in, the block is not written at all and `.cxx` stays where Expo puts it —
 * hard-coding a Windows path into a repo that also builds on EAS Linux workers
 * would break them.
 */
module.exports = function withShortCxxDir(config) {
  return withAppBuildGradle(config, (cfg) => {
    const dir = process.env.DEMLI_CXX_DIR;
    if (!dir) return cfg;
    if (cfg.modResults.language !== "groovy") return cfg;
    if (cfg.modResults.contents.includes("buildStagingDirectory")) return cfg;

    // Insert into the existing `android {` block: AGP only reads
    // buildStagingDirectory from `android.externalNativeBuild.cmake`.
    const normalised = dir.replace(/\\/g, "/");
    const injected = `android {
    externalNativeBuild {
        cmake {
            // Windows MAX_PATH: see apps/mobile/plugins/with-short-cxx-dir.js
            buildStagingDirectory "${normalised}"
        }
    }`;
    cfg.modResults.contents = cfg.modResults.contents.replace(/^android \{/m, injected);
    return cfg;
  });
};
