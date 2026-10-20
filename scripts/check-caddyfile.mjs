#!/usr/bin/env node
/**
 * Structural check for the production Caddyfile.
 *
 * `caddy validate` is the real syntax gate, but it needs the Caddy binary (or
 * Docker) and it cannot know our invariants. This script needs neither and
 * guards the rules that a human reviewer would otherwise have to eyeball:
 *
 *   1. Braces balance (outside comments and quoted strings).
 *   2. NO DUPLICATE SITE ADDRESS. Caddy refuses to load a config that defines
 *      the same site twice, taking the whole stack down. This used to be
 *      impossible to hit; it became the #1 risk on 2026-07-27 when the second
 *      public domain was retired and every `x.{$BRAND_DOMAIN}` twin collapsed
 *      onto its `x.{$DOMAIN}` original. Re-introducing a placeholder that can
 *      resolve to the same value as {$DOMAIN} would reproduce it.
 *   3. Every site address is spelled with the {$DOMAIN} placeholder — no
 *      hardcoded hostname (in particular no `karagozali.com`, whose DNS is
 *      gone) may leak back in.
 *   4. The set of hosts is EXACTLY the set that has DNS records. A vhost for a
 *      name that does not resolve makes Caddy retry its certificate forever and
 *      buries real errors in ACME noise, so adding one must be a conscious edit
 *      of EXPECTED_HOSTS here (and of the registrar).
 *   5. No `turn.*` vhost — TURN is UDP straight off the host, is not proxied by
 *      Caddy, and LiveKit accepts only one TURN realm (docs/architecture/
 *      deploy.md, "TURN is not aliased"). A turn vhost here would be cargo cult.
 *   6. The web app's CSP connect-src reaches the backend and contains no
 *      wildcard/scheme-only source, and its frame-src allows EXACTLY the one
 *      YouTube embed host Watch Party needs (ADR 0016) and nothing else. The web
 *      app is the desktop renderer mounted in a browser, so this directive and
 *      the desktop `demli-csp` one have to say the same thing — and a
 *      frame-src is the one directive where a lazy wildcard turns a video embed
 *      into "any site may be framed inside the app".
 *   7. The `/download/windows` redirect target matches the installer name
 *      electron-builder actually produces, and the publish/deploy scripts
 *      maintain that same stable alias. These three live in different files and
 *      MUST change together — a rename that misses one silently 404s the
 *      founder's download link.
 *   8. The same rule for Android, where it bites harder: FOUR files name the
 *      APK (this redirect, the MOBILE_APK_URL default in apps/api/src/env.ts,
 *      FINAL_NAME in apps/api/src/modules/hooks/download.ts, and REMOTE_NAME in
 *      scripts/publish-mobile-apk.sh). Miss one and either the download 404s or
 *      the two publishers write different files and the link goes stale. The
 *      PREVIOUS name must also still be redirected, because installs in the
 *      wild fetch the APK by URL.
 *
 * Usage:  node scripts/check-caddyfile.mjs [path/to/Caddyfile]
 * Exit code 0 = pass, 1 = fail (with the offending rule named).
 */
/* global console */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FILE = process.argv[2] ?? resolve(ROOT, "Caddyfile");

/**
 * The complete set of site addresses. One entry per DNS A record; `turn` is
 * absent on purpose (not proxied). Adding a host here without adding the DNS
 * record produces an endless ACME retry loop — do both or neither.
 */
const EXPECTED_HOSTS = [
  "{$DOMAIN}",
  "www.{$DOMAIN}",
  "app.{$DOMAIN}",
  "api.{$DOMAIN}",
  "ws.{$DOMAIN}",
  "livekit.{$DOMAIN}",
];

/** The landing block is recognised by this exact connect-src: it reaches only GitHub (nav star count). */
const LANDING_CONNECT_SRC = "'self' https://api.github.com";

/** connect-src sources the web app CSP must allow. */
const REQUIRED_CONNECT_SRC = [
  "https://api.{$DOMAIN}",
  "wss://ws.{$DOMAIN}",
  "https://livekit.{$DOMAIN}",
  "wss://livekit.{$DOMAIN}",
];

/**
 * The COMPLETE frame-src allow-list for the web app (Watch Party, ADR 0016).
 * Exact set, not a subset: a frame-src that grew a second host — or a wildcard —
 * is the difference between "we can embed a YouTube player" and "arbitrary pages
 * can be framed inside the app", and that is not a change anyone should be able
 * to make without this test failing. Must match the desktop CSP in
 * apps/desktop/electron.vite.config.ts exactly.
 */
const EXPECTED_FRAME_SRC = ["https://www.youtube-nocookie.com"];

/**
 * Hosts the web-app img-src must allow, and the desktop CSP must allow too
 * (M20 wave 3). The watch-party picker renders YouTube cover images; without
 * this the list ships with a broken-image glyph in every row on one surface and
 * not the other, which is exactly the silent divergence the frame-src rule
 * above exists to prevent. A SUBSET check, unlike frame-src: img-src legitimately
 * also carries the storage origin, and an image host cannot execute anything, so
 * the blast radius does not justify an exact-set rule.
 */
const REQUIRED_IMG_SRC = ["https://i.ytimg.com"];

/** Where the desktop CSP is built — must agree with the Caddy one. */
const DESKTOP_CSP_FILE = "apps/desktop/electron.vite.config.ts";

/** Hostnames that must never appear again (records deleted at the registrar). */
const DEAD_DOMAINS = ["karagozali.com"];

const text = readFileSync(FILE, "utf8");
const lines = text.split(/\r?\n/);

const failures = [];
const passes = [];
const fail = (rule, detail) => failures.push(`${rule}: ${detail}`);
const pass = (msg) => passes.push(msg);

/**
 * Blank out comments and quoted-string contents so braces inside them (e.g. the
 * `{$DOMAIN}` placeholders in a CSP header value) do not affect nesting depth.
 */
function stripNonCode(line) {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inQuote = !inQuote;
      out += " ";
      continue;
    }
    if (!inQuote && ch === "#") break;
    out += inQuote ? " " : ch;
  }
  return out;
}

/**
 * Placeholders like `{$DOMAIN}` are balanced, so they cancel out for depth
 * counting — but a site ADDRESS line must not be mistaken for one. We only
 * record an address when depth is 0 and the line ends in an opening brace.
 */
const siteBlocks = [];
let depth = 0;
for (let i = 0; i < lines.length; i++) {
  const code = stripNonCode(lines[i]);
  const trimmed = code.trim();
  if (depth === 0 && trimmed.endsWith("{") && trimmed !== "{") {
    siteBlocks.push({ line: i + 1, address: trimmed.slice(0, -1).trim() });
  }
  for (const ch of code) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth < 0) {
    fail("braces", `unbalanced '}' at line ${i + 1}`);
    depth = 0;
  }
}
if (depth !== 0) fail("braces", `file ends at depth ${depth}, expected 0`);
else if (!failures.length) pass("braces balanced");

const addresses = siteBlocks.map((b) => b.address);

// --- 2. no duplicate site address ------------------------------------------
// A site block may legitimately list several comma-separated addresses; every
// individual address still has to be unique across the whole file.
const seen = new Map();
const duplicates = [];
for (const block of siteBlocks) {
  for (const single of block.address.split(",").map((a) => a.trim()).filter(Boolean)) {
    if (seen.has(single)) {
      duplicates.push(`'${single}' at line ${block.line} (already at line ${seen.get(single)})`);
    } else {
      seen.set(single, block.line);
    }
  }
}
if (duplicates.length) {
  fail(
    "duplicate-site",
    `Caddy refuses to load a config with the same site defined twice — ${duplicates.join("; ")}`,
  );
} else {
  pass(`no duplicate site address (${seen.size} unique)`);
}

// --- 3 + 4. exactly the hosts that have DNS, all via {$DOMAIN} --------------
const flatAddresses = [...seen.keys()];
const hardcoded = flatAddresses.filter((a) => !a.includes("{$DOMAIN}"));
if (hardcoded.length) {
  fail(
    "placeholder",
    `site address(es) not built from {$DOMAIN}: ${hardcoded.join(", ")} — a hardcoded ` +
      `hostname cannot follow a domain change and will outlive its DNS record`,
  );
} else {
  pass("every site address uses the {$DOMAIN} placeholder");
}

const missingHosts = EXPECTED_HOSTS.filter((h) => !flatAddresses.includes(h));
const extraHosts = flatAddresses.filter((h) => !EXPECTED_HOSTS.includes(h));
if (missingHosts.length) {
  fail("hosts", `expected site block(s) missing: ${missingHosts.join(", ")}`);
}
if (extraHosts.length) {
  fail(
    "hosts",
    `unexpected site block(s): ${extraHosts.join(", ")} — every vhost needs a DNS A ` +
      `record, or Caddy retries its certificate forever. Add the record AND this ` +
      `host to EXPECTED_HOSTS in ${"scripts/check-caddyfile.mjs"}.`,
  );
}
if (!missingHosts.length && !extraHosts.length) {
  pass(`hosts exactly as expected (${EXPECTED_HOSTS.length})`);
}

// --- dead domains -----------------------------------------------------------
// Comments are exempt: the file explains WHY those names are gone, and that
// history is worth keeping. QUOTED STRINGS ARE NOT exempt — a stale hostname in
// a CSP header value is exactly the kind of live-but-invisible reference this
// rule exists to catch — so this strips comments only, unlike stripNonCode().
function stripComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inQuote = !inQuote;
    else if (ch === "#" && !inQuote) return line.slice(0, i);
  }
  return line;
}

const deadHits = [];
for (let i = 0; i < lines.length; i++) {
  const code = stripComment(lines[i]);
  for (const dead of DEAD_DOMAINS) {
    if (code.includes(dead)) deadHits.push(`line ${i + 1}: ${dead}`);
  }
}
if (deadHits.length) {
  fail("dead-domain", `${deadHits.join(", ")} — that domain no longer resolves`);
} else {
  pass("no dead domain names");
}

// --- 5. TURN is not a vhost --------------------------------------------------
const turnHost = flatAddresses.find((a) => a.startsWith("turn."));
if (turnHost) {
  fail(
    "turn",
    `site block '${turnHost}' exists — TURN is UDP/3478 straight off the host and is ` +
      `not proxied by Caddy (see docs/architecture/deploy.md, "TURN is not aliased")`,
  );
} else {
  pass("no turn.* vhost");
}

// --- 6. web-app CSP ----------------------------------------------------------
let checkedCsp = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/connect-src ([^;"]+)[;"]/);
  if (!m) continue;
  const sources = m[1].trim();
  if (sources === LANDING_CONNECT_SRC) continue; // landing block: reaches only GitHub
  checkedCsp++;
  const missing = REQUIRED_CONNECT_SRC.filter((r) => !sources.includes(r));
  if (missing.length) {
    fail("csp", `line ${i + 1}: connect-src is missing ${missing.join(", ")}`);
  }
  const overBroad = sources
    .split(/\s+/)
    .filter((s) => s === "*" || s === "https:" || s === "wss:" || s.startsWith("https://*."));
  const allowed = new Set(["https://*.supabase.co"]); // ADR 0008: direct client<->Storage
  const bad = overBroad.filter((s) => !allowed.has(s));
  if (bad.length) fail("csp", `line ${i + 1}: over-broad connect-src source(s): ${bad.join(", ")}`);
}
if (!checkedCsp) fail("csp", "no web-app connect-src directive found — did a block get renamed?");
else if (!failures.some((f) => f.startsWith("csp"))) {
  pass(`csp: ${checkedCsp} connect-src directive(s) reach the backend`);
}

// --- 6b. web-app CSP frame-src is EXACTLY the YouTube embed host ------------
// Only the app vhost declares one; the landing block frames nothing, so an
// absent frame-src there is correct and is not searched for.
let checkedFrameSrc = 0;
for (let i = 0; i < lines.length; i++) {
  // The same selector section 6 uses, for the same reason: match a real
  // Content-Security-Policy header (not a comment that mentions one), and skip
  // the landing block, whose connect-src is exactly 'self' because it talks to
  // nothing and frames nothing.
  if (!/Content-Security-Policy\s+"/.test(lines[i])) continue;
  const connect = lines[i].match(/connect-src ([^;"]+)[;"]/);
  if (!connect || connect[1].trim() === LANDING_CONNECT_SRC) continue;

  const m = lines[i].match(/frame-src ([^;"]+)[;"]/);
  if (!m) {
    fail(
      "csp-frame-src",
      `line ${i + 1}: the web app CSP has no frame-src — Watch Party's YouTube embed ` +
        `(ADR 0016) is blocked by default-src 'self' without it`,
    );
    continue;
  }
  checkedFrameSrc++;
  const sources = m[1].trim().split(/\s+/).filter(Boolean);
  const extra = sources.filter((s) => !EXPECTED_FRAME_SRC.includes(s));
  const missing = EXPECTED_FRAME_SRC.filter((s) => !sources.includes(s));
  if (missing.length) {
    fail("csp-frame-src", `line ${i + 1}: frame-src is missing ${missing.join(", ")}`);
  }
  if (extra.length) {
    fail(
      "csp-frame-src",
      `line ${i + 1}: frame-src allows ${extra.join(", ")} — the allow-list is EXACTLY ` +
        `${EXPECTED_FRAME_SRC.join(", ")} (see the comment on EXPECTED_FRAME_SRC)`,
    );
  }
}
if (checkedFrameSrc && !failures.some((f) => f.startsWith("csp-frame-src"))) {
  pass(`csp: frame-src pinned to ${EXPECTED_FRAME_SRC.join(", ")}`);
}

// --- 6c. img-src carries the thumbnail host, on BOTH surfaces ---------------
// `readIfPresent` is a hoisted function declaration (defined under section 7).
let checkedImgSrc = 0;
for (let i = 0; i < lines.length; i++) {
  if (!/Content-Security-Policy\s+"/.test(lines[i])) continue;
  const connect = lines[i].match(/connect-src ([^;"]+)[;"]/);
  if (!connect || connect[1].trim() === LANDING_CONNECT_SRC) continue; // landing block: no app

  const m = lines[i].match(/img-src ([^;"]+)[;"]/);
  if (!m) {
    fail("csp-img-src", `line ${i + 1}: the web app CSP has no img-src directive`);
    continue;
  }
  checkedImgSrc++;
  const sources = m[1].trim().split(/\s+/).filter(Boolean);
  const missing = REQUIRED_IMG_SRC.filter((s) => !sources.includes(s));
  if (missing.length) {
    fail(
      "csp-img-src",
      `line ${i + 1}: img-src is missing ${missing.join(", ")} — the Watch Party video ` +
        `picker's cover images are blocked without it`,
    );
  }
}
if (checkedImgSrc && !failures.some((f) => f.startsWith("csp-img-src"))) {
  pass(`csp: img-src allows ${REQUIRED_IMG_SRC.join(", ")}`);
}

const desktopCsp = readIfPresent(DESKTOP_CSP_FILE);
if (desktopCsp === null) {
  fail("csp-img-src", `${DESKTOP_CSP_FILE} not found`);
} else {
  const missingDesktop = REQUIRED_IMG_SRC.filter((s) => !desktopCsp.includes(s));
  if (missingDesktop.length) {
    fail(
      "csp-img-src",
      `${DESKTOP_CSP_FILE} does not allow ${missingDesktop.join(", ")} in img-src — the ` +
        `desktop and web CSPs must say the same thing, or the picker's covers load in a ` +
        `browser and show as broken images in the packaged app`,
    );
  } else {
    pass(`${DESKTOP_CSP_FILE} img-src agrees with the Caddyfile`);
  }
}

// --- 7. the download alias agrees with what electron-builder produces --------
// electron-builder.yml:  productName + nsis.artifactName -> "<product>-Setup-<ver>.exe"
// Caddyfile:             /download/windows -> ".../<product>-Setup.exe"  (version-less)
// publish-desktop.sh + deploy.sh: maintain that version-less symlink.
// Read the YAML with a narrow regex rather than adding a yaml dependency to the
// repo root just for a lint script.
function readIfPresent(relative) {
  try {
    return readFileSync(resolve(ROOT, relative), "utf8");
  } catch {
    return null;
  }
}

const builderYml = readIfPresent("apps/desktop/electron-builder.yml");
if (!builderYml) {
  fail("download-alias", "apps/desktop/electron-builder.yml not found");
} else {
  const productName = builderYml.match(/^productName:\s*(\S+)\s*$/m)?.[1];
  const nsisArtifact = builderYml.match(/^\s+artifactName:\s*(\$\{productName\}-Setup[^\s]*)\s*$/m)?.[1];
  if (!productName) {
    fail("download-alias", "could not read `productName` from electron-builder.yml");
  } else if (!nsisArtifact) {
    fail(
      "download-alias",
      "could not find the NSIS `artifactName: ${productName}-Setup-…` line in electron-builder.yml",
    );
  } else {
    const stableAlias = `${productName}-Setup.exe`;
    const redirLine = lines.findIndex((l) => /redir\s+\S+\/dl\/desktop\/\S+\.exe/.test(l));
    const redirTarget = redirLine >= 0 ? lines[redirLine].match(/([^/\s]+\.exe)/)?.[1] : null;
    if (redirTarget !== stableAlias) {
      fail(
        "download-alias",
        `Caddyfile /download/windows redirects to '${redirTarget ?? "(none)"}' but ` +
          `electron-builder produces '${productName}-Setup-<version>.exe', so the stable ` +
          `alias must be '${stableAlias}'`,
      );
    } else {
      pass(`download alias '${stableAlias}' matches electron-builder productName`);
    }

    for (const script of ["scripts/publish-desktop.sh", "scripts/deploy.sh"]) {
      const body = readIfPresent(script);
      if (body === null) {
        fail("download-alias", `${script} not found`);
      } else if (!body.includes(stableAlias)) {
        fail(
          "download-alias",
          `${script} does not mention '${stableAlias}' — it maintains the symlink the ` +
            `Caddy redirect points at, so it must be renamed at the same time`,
        );
      } else {
        pass(`${script} maintains '${stableAlias}'`);
      }
    }
  }
}

// --- 8. the Android APK alias agrees across all four files that name it ------
// Caddyfile:        /download/android -> ".../dl/mobile/<name>.apk"
// env.ts:           MOBILE_APK_URL default ends with that same <name>.apk
// hooks/download.ts FINAL_NAME  = "<name>.apk"   (EAS webhook writes it)
// publish-mobile-apk.sh REMOTE_NAME = "<name>.apk" (manual/local-build path)

const androidRedirLine = lines.findIndex((l) =>
  /redir\s+\S+\/dl\/mobile\/\S+\.apk/.test(stripComment(l)),
);
const apkName =
  androidRedirLine >= 0
    ? stripComment(lines[androidRedirLine]).match(/\/dl\/mobile\/([^/\s]+\.apk)/)?.[1]
    : null;

if (!apkName) {
  fail("apk-alias", "no `/download/android` redirect to /dl/mobile/<name>.apk found in the Caddyfile");
} else {
  pass(`android download alias '${apkName}'`);

  /** @type {[string, RegExp, string][]} name, pattern that must contain the apk name, why */
  const apkSources = [
    [
      "apps/api/src/env.ts",
      /MOBILE_APK_URL:\s*z[^\n]*?\.default\("([^"]+)"\)/,
      "the default GET /mobile/version advertises to every install",
    ],
    [
      "apps/api/src/modules/hooks/download.ts",
      /FINAL_NAME\s*=\s*"([^"]+)"/,
      "the filename the EAS build webhook writes",
    ],
    [
      "scripts/publish-mobile-apk.sh",
      /^REMOTE_NAME="([^"]+)"/m,
      "the filename the manual/local-build publish path uploads",
    ],
    [
      "docker-compose.prod.yml",
      /MOBILE_APK_URL:\s*"([^"]+)"/,
      "the value pinned for production (overrides .env.prod)",
    ],
  ];

  for (const [file, pattern, why] of apkSources) {
    const body = readIfPresent(file);
    if (body === null) {
      fail("apk-alias", `${file} not found`);
      continue;
    }
    const found = body.match(pattern)?.[1];
    if (!found) {
      fail("apk-alias", `could not read the APK name from ${file} — did the declaration move?`);
    } else if (!found.endsWith(apkName)) {
      fail(
        "apk-alias",
        `${file} names '${found}' but the Caddy download alias is '${apkName}' (${why}) — ` +
          `rename both or the link breaks`,
      );
    } else {
      pass(`${file} agrees on '${apkName}'`);
    }
  }

}

console.log(`Caddyfile: ${FILE}`);
console.log(`Site blocks: ${addresses.join(", ")}`);
for (const p of passes) console.log(`  ok   ${p}`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Caddyfile invariants hold.");
