#!/usr/bin/env node
/**
 * Refuse to publish a landing build that carries anything we may not publish.
 *
 * The landing was rebuilt against a licensed template. Its media (videos,
 * images, noise textures …) sit UNTRACKED in apps/landing/public on the
 * founder's machine so the clone can be compared side by side — and Next's
 * static export copies everything in public/ into out/. One `publish-landing.sh`
 * would then put licensed files on getdemli.com.
 *
 * So the build output is checked against an allow-list before any upload:
 *   - `_next/**`           Next's own build output (hashed chunks, CSS, fonts);
 *   - `*.html`, `*.txt`    the exported routes and their RSC route data;
 *   - files TRACKED in git under apps/landing/public (`git ls-files`).
 * Anything else refuses the publish — and so does any file that exists in
 * apps/landing/public without being tracked, whatever its extension.
 *
 * Usage:  node scripts/check-landing-dist.mjs <dist-dir>
 * Exit 0 = publishable, 1 = refused (each offending file listed), 2 = usage.
 */
/* global console, process */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REL = "apps/landing/public";

/** Every file under `dir`, as POSIX paths relative to it. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The files in a build that must NOT be published, with the reason.
 *
 * @param {string[]} distFiles   POSIX paths relative to the build dir.
 * @param {{ tracked: Set<string>, inPublic: (rel: string) => boolean }} source
 *   `tracked`: paths tracked in git under apps/landing/public (relative to it);
 *   `inPublic`: whether that path exists on disk under apps/landing/public.
 */
export function unpublishableFiles(distFiles, { tracked, inPublic }) {
  const refused = [];
  for (const rel of distFiles) {
    if (inPublic(rel) && !tracked.has(rel)) {
      refused.push({ file: rel, reason: `untracked file from ${PUBLIC_REL} (never published)` });
      continue;
    }
    if (rel.startsWith("_next/")) continue;
    if (/\.(html|txt)$/.test(rel)) continue;
    if (tracked.has(rel)) continue;
    refused.push({ file: rel, reason: "not a build artefact and not tracked in git" });
  }
  return refused;
}

function trackedPublicFiles() {
  const stdout = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", PUBLIC_REL], {
    encoding: "utf8",
  });
  return new Set(
    stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => p.slice(PUBLIC_REL.length + 1)),
  );
}

function main(argv) {
  const dist = argv[2];
  if (!dist || !existsSync(dist) || !statSync(dist).isDirectory()) {
    console.error("usage: node scripts/check-landing-dist.mjs <dist-dir>");
    return 2;
  }
  const tracked = trackedPublicFiles();
  const publicDir = join(ROOT, PUBLIC_REL);
  const refused = unpublishableFiles(listFiles(dist), {
    tracked,
    inPublic: (rel) => existsSync(join(publicDir, ...rel.split("/"))),
  });
  if (refused.length) {
    console.error(`REFUSED: ${refused.length} file(s) in ${dist} may not be published:`);
    for (const { file, reason } of refused) console.error(`  ${file} — ${reason}`);
    console.error(
      "Remove them from apps/landing/public (or commit them, if they are ours to publish) and rebuild.",
    );
    return 1;
  }
  console.log(`OK — every file in ${dist} is a build artefact or tracked in git.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  process.exit(main(process.argv));
}
