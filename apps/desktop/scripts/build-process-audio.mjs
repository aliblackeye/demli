// Build the Windows process-audio helper from source.
//
//   pnpm --filter @demli/desktop build:process-audio
//
// Source:  apps/desktop/native/process-audio/src/main.cpp
// Output:  apps/desktop/resources/process-audio/win32-x64/demli-audio-capture.exe
//
// Toolchain: MinGW-w64 g++ (MSYS2 UCRT64). Set DEMLI_MINGW_BIN to its bin
// directory when it is not at C:/msys64/ucrt64/bin. The binary is linked fully
// static (no libstdc++/libgcc/winpthread DLLs next to it) and built with
// deterministic flags, so rebuilding unchanged source reproduces the committed
// file byte for byte (checked by `--check`).
//
// Static linking embeds the MinGW-w64 runtime and winpthreads in the binary,
// and both licences require their notices in every binary copy. The build and
// `--check` fail unless resources/process-audio/LICENSE contains the
// toolchain's own copy of each notice whose code the binary carries.
//
//   node scripts/build-process-audio.mjs --check   # rebuild to a temp file, compare
/* global console, process */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const source = join(desktopDir, "native", "process-audio", "src", "main.cpp");
const destDir = join(desktopDir, "resources", "process-audio", "win32-x64");
const exeName = "demli-audio-capture.exe";
const dest = join(destDir, exeName);
const licenseFile = join(desktopDir, "resources", "process-audio", "LICENSE");

const mingwBin = process.env.DEMLI_MINGW_BIN ?? "C:/msys64/ucrt64/bin";
const gxx = join(mingwBin, process.platform === "win32" ? "g++.exe" : "g++");

if (!existsSync(gxx)) {
  console.error(`g++ not found at ${gxx}. Install MSYS2 UCRT64 g++ or set DEMLI_MINGW_BIN.`);
  process.exit(1);
}

const check = process.argv.includes("--check");
const work = mkdtempSync(join(tmpdir(), "demli-process-audio-"));
const built = join(work, exeName);

const flags = [
  "-std=c++17",
  "-O2",
  "-municode",
  "-DUNICODE",
  "-D_UNICODE",
  "-D_WIN32_WINNT=0x0A00",
  "-DWINVER=0x0A00",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-static",
  "-static-libgcc",
  "-static-libstdc++",
  // Reproducibility: no build timestamp in the PE header, no path-dependent
  // debug info. `-s` strips at link time; a separate `strip` pass would stamp
  // the PE header with the current time.
  "-Wl,--no-insert-timestamp",
  "-ffile-prefix-map=" + desktopDir.replace(/\\/g, "/") + "=.",
  "-s",
  source,
  "-o",
  built,
  "-lole32",
  "-luuid",
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const licensesDir = join(mingwBin, "..", "share", "licenses");

// Each statically linked component: a byte marker that proves its code is in
// the binary, and the toolchain file holding the notice that must ship with it.
const embeddedNotices = [
  {
    name: "MinGW-w64 runtime",
    marker: "Mingw-w64 runtime failure",
    notice: join(licensesDir, "crt", "COPYING.MinGW-w64-runtime.txt"),
  },
  {
    name: "mingw-w64 winpthreads",
    marker: "winpthreads",
    notice: join(licensesDir, "winpthreads", "COPYING"),
  },
];

const normalize = (text) => text.replace(/\s+/g, " ").trim();

/** Names of embedded components whose notice is missing from LICENSE. */
function missingNotices(binary) {
  const bytes = readFileSync(binary).toString("latin1");
  const license = normalize(readFileSync(licenseFile, "utf8"));
  const missing = [];
  for (const component of embeddedNotices) {
    if (!bytes.includes(component.marker)) continue;
    if (!existsSync(component.notice)) {
      missing.push(`${component.name} (toolchain notice ${component.notice} not found)`);
      continue;
    }
    if (!license.includes(normalize(readFileSync(component.notice, "utf8")))) {
      missing.push(component.name);
    }
  }
  return missing;
}

try {
  // g++ resolves its own runtime pieces through PATH on Windows.
  const env = { ...process.env, PATH: `${mingwBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` };
  execFileSync(gxx, flags, { stdio: "inherit", env });

  const imports = execFileSync(join(mingwBin, "objdump.exe"), ["-p", built], { env })
    .toString()
    .split("\n")
    .filter((line) => /DLL Name:/.test(line))
    .map((line) => line.replace(/.*DLL Name:\s*/, "").trim().toLowerCase());
  const forbidden = imports.filter((dll) => /libstdc\+\+|libgcc|libwinpthread/.test(dll));
  if (forbidden.length > 0) {
    throw new Error(`binary still depends on MinGW runtime DLLs: ${forbidden.join(", ")}`);
  }

  const missing = missingNotices(built);
  if (missing.length > 0) {
    throw new Error(
      `the binary embeds code whose notice is missing from ${licenseFile}: ${missing.join(", ")}`,
    );
  }

  const hash = sha256(built);
  if (check) {
    if (!existsSync(dest)) throw new Error(`${dest} does not exist`);
    const committed = sha256(dest);
    if (committed !== hash) {
      throw new Error(`committed ${exeName} (${committed}) differs from a fresh build (${hash})`);
    }
    console.log(`OK ${exeName} matches a fresh build (sha256 ${hash})`);
  } else {
    mkdirSync(destDir, { recursive: true });
    copyFileSync(built, dest);
    console.log(`Built ${dest}`);
    console.log(`  sha256  ${hash}`);
    console.log(`  imports ${imports.join(", ")}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
