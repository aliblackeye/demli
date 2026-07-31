// Refresh the vendored Windows process-loopback helper binaries from the pinned
// `application-loopback` npm tarball. Committing the exes keeps the packaged app
// self-contained (no native build); this script makes updating them reproducible.
//
//   pnpm --filter @demli/desktop sync:process-audio-bins
//
// Bump PINNED_VERSION to take a newer upstream, then review the diff and commit.
/* global console */
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_VERSION = "1.2.7";
const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, "..", "resources", "process-audio", "win32-x64");
const EXES = ["ApplicationLoopback.exe", "ProcessList.exe"];

const work = mkdtempSync(join(tmpdir(), "demli-al-"));
try {
  const url = `https://registry.npmjs.org/application-loopback/-/application-loopback-${PINNED_VERSION}.tgz`;
  const tgz = join(work, "al.tgz");
  console.log(`Downloading application-loopback@${PINNED_VERSION} …`);
  execFileSync("curl", ["-sL", url, "-o", tgz], { stdio: "inherit" });
  execFileSync("tar", ["-xzf", tgz, "-C", work], { stdio: "inherit" });
  const binDir = join(work, "package", "bin", "win32-x64");
  for (const exe of EXES) {
    const src = join(binDir, exe);
    if (!existsSync(src)) throw new Error(`missing ${exe} in tarball`);
    copyFileSync(src, join(destDir, exe));
    console.log(`  ✓ ${exe}`);
  }
  console.log(`Updated ${destDir}. Review the diff and commit.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
