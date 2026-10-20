/**
 * Landing publish allow-list (scripts/check-landing-dist.mjs).
 * Run: node --test scripts/check-landing-dist.test.mjs   (part of `pnpm lint`)
 */
/* global process */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unpublishableFiles } from "./check-landing-dist.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-landing-dist.mjs");

const source = (tracked, onDisk = tracked) => ({
  tracked: new Set(tracked),
  inPublic: (rel) => onDisk.includes(rel),
});

test("build artefacts and tracked public files are publishable", () => {
  const files = [
    "_next/static/chunks/main-abc.js",
    "_next/static/media/inter.woff2",
    "index.html",
    "index.txt",
    "design/atomlar.html",
    "design/atomlar.txt",
    "404.html",
    "favicon.ico",
    "images/demli-og.png",
  ];
  assert.deepEqual(unpublishableFiles(files, source(["favicon.ico", "images/demli-og.png"])), []);
});

test("an untracked template asset copied from public/ is refused", () => {
  const files = ["index.html", "videos/light-rays-hero.webm", "images/hero-phone.webp"];
  const refused = unpublishableFiles(
    files,
    source([], ["videos/light-rays-hero.webm", "images/hero-phone.webp"]),
  );
  assert.deepEqual(
    refused.map((r) => r.file),
    ["videos/light-rays-hero.webm", "images/hero-phone.webp"],
  );
});

test("an untracked public file is refused even with an allowed extension", () => {
  const refused = unpublishableFiles(["licence-notes.txt"], source([], ["licence-notes.txt"]));
  assert.equal(refused.length, 1);
});

test("a stray file that is neither an artefact nor tracked is refused", () => {
  const refused = unpublishableFiles(["secrets.json"], source([]));
  assert.deepEqual(refused.map((r) => r.file), ["secrets.json"]);
});

test("the CLI exits 1 and names the file for a dist with an unknown file", () => {
  const dir = mkdtempSync(join(tmpdir(), "landing-dist-"));
  try {
    writeFileSync(join(dir, "index.html"), "<html></html>");
    mkdirSync(join(dir, "videos"));
    writeFileSync(join(dir, "videos", "not-ours.webm"), "x");
    let code = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, dir], { stdio: "pipe", encoding: "utf8" });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr);
    }
    assert.equal(code, 1);
    assert.match(stderr, /videos\/not-ours\.webm/);

    rmSync(join(dir, "videos"), { recursive: true });
    const ok = execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    assert.match(ok, /^OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
