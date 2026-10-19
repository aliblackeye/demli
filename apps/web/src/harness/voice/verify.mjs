/**
 * Headless verification for the voice & call harness (M16 Dalga 3, dev only).
 *
 *   node apps/web/src/harness/voice/verify.mjs [baseUrl] [shotDir]
 *
 * Drives `/harness-voice.html` (served by `pnpm --filter @demli/web dev`) with
 * playwright-core + the system Chrome (`channel: "chrome"`, headless) and FAILS
 * (exit 1) on any check that does not hold:
 *
 *   - zero console errors / warnings / page errors, in every harness mode;
 *   - computed styles prove the Koyu Masa tokens are what renders (surfaces,
 *     radii, Onest + Inter actually loaded, no borders on the cards);
 *   - hover / focus-visible / pressed each change the computed state;
 *   - open/close animations run AND finish (no element left mid-animation,
 *     exits unmount);
 *   - keyboard paths: radio groups and segmented controls move with arrows;
 *   - prefers-reduced-motion stops the infinite loops and collapses transitions.
 *
 * Screenshots land in `shotDir` (default <repo>/tmp/m16-shots/voice, gitignored)
 * as evidence for the design audit — never as the proof itself.
 *
 * playwright-core is not a workspace dependency (nothing in the product needs
 * it); point PLAYWRIGHT_CORE at an install, or have it resolvable from here.
 */

// Node script whose page.evaluate / $eval callbacks run IN THE BROWSER, so
// both environments' globals appear in this one file.
/* global console, process, document, getComputedStyle, Image, window */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://127.0.0.1:5191";
const shotDir = resolve(process.argv[3] ?? join(here, "../../../../../tmp/m16-shots/voice"));
mkdirSync(shotDir, { recursive: true });

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function openPage(query = "", opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: opts.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  const messages = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") messages.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => messages.push(`pageerror: ${err.message}`));
  await page.goto(`${base}/harness-voice.html${query}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="sec-watch"]', { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, context, messages };
}

const css = (page, selector, props) =>
  page.$eval(
    selector,
    (el, ps) => {
      const s = getComputedStyle(el);
      return Object.fromEntries(ps.map((p) => [p, s.getPropertyValue(p)]));
    },
    props,
  );

/** Wait until no animation on the element (or its subtree) is still running. */
async function animationsSettle(page, selector, timeout = 2000) {
  return page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return true;
      return el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .every((a) => a.playState === "finished" || a.playState === "idle");
    },
    selector,
    { timeout },
  );
}

// ── 1. default mode (web picker, friends ready) ─────────────────────────────
{
  const { page, context, messages } = await openPage();

  // Fonts: Inter body, Onest display — actually loaded, not just named.
  const fonts = await page.evaluate(() => ({
    inter: document.fonts.check('16px "Inter"'),
    onest: document.fonts.check('20px "Onest"'),
    body: getComputedStyle(document.body).fontFamily,
    h1: getComputedStyle(document.querySelector("h1")).fontFamily,
  }));
  check("Inter loaded + body font", fonts.inter && /^"?Inter"?,/.test(fonts.body), fonts.body);
  check("Onest loaded + display font", fonts.onest && /^"?Onest"?,/.test(fonts.h1), fonts.h1);

  // Voice panel: surface tone, radius 16, borderless, no outer shadow.
  const panel = await css(page, '[data-testid="voice-panel"]', [
    "background-color",
    "border-top-left-radius",
    "border-top-width",
    "box-shadow",
  ]);
  check(
    "voice panel = surface #171717, radius 16, no border/shadow",
    panel["background-color"] === "rgb(23, 23, 23)" &&
      panel["border-top-left-radius"] === "16px" &&
      panel["border-top-width"] === "0px" &&
      panel["box-shadow"] === "none",
    JSON.stringify(panel),
  );
  const sidebar = await css(page, '[data-testid="sidebar-column"]', ["background-color"]);
  check("sidebar column = base #0d0d0d", sidebar["background-color"] === "rgb(13, 13, 13)", sidebar["background-color"]);

  // Status line in coral while connected.
  const status = await css(page, '[data-testid="voice-panel"] [role="status"]', ["color", "font-family"]);
  check("connected status = accent #ff8464", status.color === "rgb(255, 132, 100)", status.color);

  // Stage: page black + base-tone card radius 24, borderless.
  const stage = await css(page, '[data-testid="video-stage"]', ["background-color", "background-image"]);
  check(
    "stage = page black + coral top light from the accent token",
    stage["background-color"] === "rgb(0, 0, 0)" && stage["background-image"].includes("radial-gradient"),
    stage["background-color"],
  );
  const card = await css(page, '[data-testid="video-stage"] > div:nth-child(2)', [
    "background-color",
    "border-top-left-radius",
    "border-top-width",
  ]);
  check(
    "stage card = base #0d0d0d, radius 24, no border",
    card["background-color"] === "rgb(13, 13, 13)" && card["border-top-left-radius"] === "24px" && card["border-top-width"] === "0px",
    JSON.stringify(card),
  );

  // Tile label = veil pill over media (scrim tone + blur, pill radius).
  const label = await css(page, '[data-testid="tile-camera"] [data-testid="tile-label"]', [
    "background-color",
    "border-top-left-radius",
    "backdrop-filter",
  ]);
  check(
    "tile label = scrim pill + blur",
    label["background-color"] === "rgba(0, 0, 0, 0.55)" && label["border-top-left-radius"] === "50px" && label["backdrop-filter"].includes("blur"),
    JSON.stringify(label),
  );

  // Received resolution is measured from the decoded frames.
  await page.waitForSelector('[data-testid="tile-share"] [data-testid="share-quality"]', { timeout: 8000 });
  const quality = await page.textContent('[data-testid="tile-share"] [data-testid="share-quality"]');
  check("share quality pill shows the measured height", quality === "1080p", quality ?? "");

  // ── hover: participant row tone change (transparent → #171717), 200ms ──
  const row = page.locator('[data-testid="voice-participant"]').nth(2);
  const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const duration = await row.evaluate((el) => getComputedStyle(el).transitionDuration);
  await row.hover();
  await page.waitForTimeout(320);
  const after = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  check("row hover = tone change to #171717", before === "rgba(0, 0, 0, 0)" && after === "rgb(23, 23, 23)", `${before} → ${after}`);
  check("row hover transition = 200ms", duration.split(",")[0].trim() === "0.2s", duration);
  const rowTransform = await row.evaluate((el) => getComputedStyle(el).transform);
  check("row hover does not move the row", rowTransform === "none", rowTransform);

  // ── speaking light on the sidebar avatar and the stage tile ──
  const speakingRow = page.locator('[data-testid="voice-participant"][data-speaking]').first();
  const glow = await speakingRow.locator("[data-speaking]").first().evaluate((el) => getComputedStyle(el).boxShadow);
  check("speaking avatar carries the coral glow", glow.includes("rgba(255, 132, 100"), glow);

  await page.click('[data-testid="speak-3"]');
  await page.waitForTimeout(320);
  const tileGlow = await page
    .locator('[data-testid="tile-avatar-deafened"] [data-testid="speaking-glow"]')
    .evaluate((el) => ({ o: getComputedStyle(el).opacity, s: getComputedStyle(el).boxShadow }));
  check(
    "speaking glow fades in (inset coral ring)",
    tileGlow.o === "1" && tileGlow.s.includes("inset") && tileGlow.s.includes("rgb(255, 132, 100)"),
    JSON.stringify(tileGlow),
  );

  // ── mic toggle: pressed state + pink "off" wash ──
  const mic = page.locator('[data-testid="voice-panel"] button[aria-pressed]').first();
  const micBefore = await mic.evaluate((el) => [el.getAttribute("aria-pressed"), getComputedStyle(el).backgroundColor]);
  await mic.click();
  await page.waitForTimeout(260);
  const micAfter = await mic.evaluate((el) => [
    el.getAttribute("aria-pressed"),
    getComputedStyle(el).backgroundColor,
    el.getAttribute("aria-label"),
    getComputedStyle(el).color,
  ]);
  // Tailwind v4 mixes the /12 wash in oklab, so the background is compared as
  // "changed + translucent"; the ink must be the exact danger token.
  check(
    "mic toggle: aria-pressed + pink off wash + label flips",
    micBefore[0] === "false" &&
      micAfter[0] === "true" &&
      micAfter[1] !== micBefore[1] &&
      /\/ 0\.(12|2)\)$/.test(micAfter[1]) &&
      micAfter[3] === "rgb(255, 111, 181)",
    `${JSON.stringify(micBefore)} → ${JSON.stringify(micAfter)}`,
  );

  // ── pressed: the control gives on press (scale 0.96), returns on release ──
  const leaveBox = await page.locator('[data-testid="voice-panel-leave"]').boundingBox();
  await page.mouse.move(leaveBox.x + leaveBox.width / 2, leaveBox.y + leaveBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(260);
  const pressedScale = await page.$eval('[data-testid="voice-panel-leave"]', (el) => getComputedStyle(el).scale);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  check("pressed control scales to 0.96", pressedScale === "0.96", pressedScale);

  // ── focus-visible: keyboard focus draws the coral ring ──
  await page.focus('[data-testid="status-connected"]');
  await page.keyboard.press("Tab");
  await page.waitForTimeout(320);
  const focusRing = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, shadow: el ? getComputedStyle(el).boxShadow : "" };
  });
  check("focus-visible ring is coral", focusRing.shadow.includes("rgb(255, 132, 100)"), JSON.stringify(focusRing));

  // ── stage control bar: leave is the wide solid pink pill ──
  const leave = await css(page, '[data-testid="bar-box"] [data-testid="stage-leave"]', [
    "background-color",
    "color",
    "width",
    "height",
  ]);
  check(
    "stage leave = solid danger + dark ink + wider than tall",
    leave["background-color"] === "rgb(255, 111, 181)" && leave.color === "rgb(23, 23, 23)" && parseFloat(leave.width) > parseFloat(leave.height),
    JSON.stringify(leave),
  );
  const bar = await css(page, '[data-testid="bar-box"] [data-testid="stage-control-bar"]', ["background-color", "backdrop-filter", "border-top-left-radius"]);
  check("stage bar = strong glass pill", bar["background-color"] === "rgba(23, 23, 23, 0.92)" && bar["backdrop-filter"].includes("blur"), JSON.stringify(bar));

  // The harness scrolls inside its own column, so a section taller than the
  // viewport would be clipped: grow the viewport for the two tall shots.
  await page.setViewportSize({ width: 1440, height: 2100 });
  await page.waitForTimeout(300);
  await page.locator('[data-testid="sec-panel"]').screenshot({ path: join(shotDir, "01-panel.png") });
  await page.locator('[data-testid="sec-stage"]').screenshot({ path: join(shotDir, "02-stage.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ── stage focus → PiP self-view → back to grid ──
  await page.click('[data-testid="stage-box"] [data-testid="avatar-tile"] >> nth=1');
  await page.waitForSelector('[data-testid="stage-box"] [data-testid="stage-pip"]', { timeout: 3000 });
  await animationsSettle(page, '[data-testid="stage-box"]');
  const mode = await page.getAttribute('[data-testid="video-stage"]', "data-mode");
  check("click a tile → focus mode + self-view PiP", mode === "focus");
  await page.locator('[data-testid="stage-box"]').screenshot({ path: join(shotDir, "03-stage-focus.png") });

  // fullscreen enters with a fade and Esc leaves it
  await page.click('[data-testid="stage-camera"]');
  await page.waitForTimeout(400);
  const fsButton = page.locator('[data-testid="stage-box"] [data-testid="video-stage"] [aria-label="Tam ekran"]').first();
  await fsButton.click();
  await page.waitForSelector('[data-testid="video-stage"][data-fullscreen]', { timeout: 2000 });
  await animationsSettle(page, '[data-testid="video-stage"][data-fullscreen]');
  await page.screenshot({ path: join(shotDir, "04-stage-fullscreen.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="video-stage"][data-fullscreen]'));
  check("fullscreen opens (fade) and Esc closes", true);
  await page.click('[data-testid="stage-camera"]');

  // ── incoming call: enter animation finishes, halo breathes, exit unmounts ──
  await page.click('[data-testid="incoming-video"]');
  await page.waitForSelector('[data-testid="incoming-call"]');
  await page.waitForTimeout(500);
  const ring = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="incoming-call"]');
    const cardEl = overlay?.firstElementChild;
    const halo = document.querySelector('[data-testid="incoming-call-halo"]');
    return {
      overlayOpacity: overlay ? getComputedStyle(overlay).opacity : "",
      cardBg: cardEl ? getComputedStyle(cardEl).backgroundColor : "",
      cardRadius: cardEl ? getComputedStyle(cardEl).borderTopLeftRadius : "",
      haloAnim: halo ? getComputedStyle(halo).animationName : "",
      focusInside: overlay?.contains(document.activeElement) ?? false,
      labels: [...(overlay?.querySelectorAll("button[aria-label]") ?? [])].map((b) => b.getAttribute("aria-label")),
    };
  });
  check(
    "incoming card: base tone, radius 24, opaque after enter",
    ring.overlayOpacity === "1" && ring.cardBg === "rgb(13, 13, 13)" && ring.cardRadius === "24px",
    JSON.stringify(ring),
  );
  check("incoming halo breathes (pulse-ring)", ring.haloAnim === "pulse-ring", ring.haloAnim);
  check("incoming: focus moved inside the ring card", ring.focusInside);
  check("incoming: three labelled actions", ring.labels.length === 3, ring.labels.join(" | "));
  await page.screenshot({ path: join(shotDir, "05-incoming.png") });
  await page.click('[data-testid="incoming-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="incoming-call"]'), null, { timeout: 2000 });
  check("incoming exit animation completes and unmounts", true);

  // ── call pill: glass pill, enters on the spring ──
  await page.click('[data-testid="pill-here"]');
  await page.waitForSelector('[data-testid="call-pill"]');
  await animationsSettle(page, '[data-testid="call-pill"]');
  await page.waitForTimeout(700);
  const pill = await css(page, '[data-testid="call-pill"] > div', ["background-color", "backdrop-filter", "border-top-left-radius"]);
  check("call pill = strong glass, pill radius", pill["background-color"] === "rgba(23, 23, 23, 0.92)" && pill["border-top-left-radius"] === "50px", JSON.stringify(pill));
  await page.screenshot({ path: join(shotDir, "06-pill.png"), clip: { x: 0, y: 860, width: 520, height: 140 } });
  await page.click('[data-testid="pill-here"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="call-pill"]'), null, { timeout: 2000 });

  // ── dialogs: source picker (web surfaces) — open animation, radios, Esc close ──
  await page.click('[data-testid="open-picker"]');
  await page.waitForSelector('[role="dialog"][data-state="open"]');
  await animationsSettle(page, '[role="dialog"]');
  const dialog = await css(page, '[role="dialog"]', ["background-color", "border-top-left-radius", "animation-name"]);
  check("picker dialog = base card radius 24", dialog["background-color"] === "rgb(13, 13, 13)" && dialog["border-top-left-radius"] === "24px", JSON.stringify(dialog));
  await page.click('[role="dialog"] [data-testid="source-card"] >> nth=0');
  await page.waitForSelector('[role="dialog"] [role="radiogroup"] [role="radio"]');
  const radio = page.locator('[role="dialog"] [role="radiogroup"] [role="radio"][aria-checked="true"]').first();
  await radio.focus();
  const radioBefore = await radio.getAttribute("data-testid");
  await page.keyboard.press("ArrowDown");
  const radioAfter = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  const radioChecked = await page.evaluate(() => document.activeElement?.getAttribute("aria-checked"));
  check("sound radios: ArrowDown moves + selects", radioBefore !== radioAfter && radioChecked === "true", `${radioBefore} → ${radioAfter}`);
  const seg = page.locator('[data-testid="share-resolution"] [aria-checked="true"]');
  const segBefore = await seg.textContent();
  await seg.focus();
  await page.keyboard.press("ArrowRight");
  const segAfter = await page.evaluate(() => document.activeElement?.textContent);
  check("resolution segmented: ArrowRight moves + selects", segBefore !== segAfter, `${segBefore} → ${segAfter}`);
  await page.screenshot({ path: join(shotDir, "07-picker-web.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 2000 });
  check("picker closes on Esc after its exit animation", true);

  // camera preview: starts with the skeleton, then the live frame
  await page.click('[data-testid="open-preview"]');
  await page.waitForSelector('[data-testid="camera-preview"][data-state="ready"]', { timeout: 5000 });
  check("camera preview reaches the live frame", true);
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "08-camera-preview.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // device settings: radio rows with arrow keys
  await page.click('[data-testid="open-devices"]');
  await page.waitForSelector('[data-testid="device-group-audioinput"] [role="radio"]');
  await animationsSettle(page, '[role="dialog"]');
  const mic0 = page.locator('[data-testid="device-group-audioinput"] [role="radio"][aria-checked="true"]');
  await mic0.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(320);
  const micSel = await page.$$eval('[data-testid="device-group-audioinput"] [role="radio"]', (els) => els.map((e) => e.getAttribute("aria-checked")));
  check("device radios: ArrowDown selects the next mic", micSel.join(",") === "false,true", micSel.join(","));
  const selRow = await css(page, '[data-testid="device-group-audioinput"] [role="radio"][aria-checked="true"]', ["background-color"]);
  check("selected device row = coral wash", selRow["background-color"] === "rgba(255, 132, 100, 0.12)", selRow["background-color"]);
  await page.screenshot({ path: join(shotDir, "09-devices.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // join guard: focus lands on Cancel, never on the destructive confirm
  await page.click('[data-testid="open-guard"]');
  await page.waitForSelector('[data-testid="join-guard-confirm"]');
  await animationsSettle(page, '[role="dialog"]');
  const guardFocus = await page.evaluate(() => document.activeElement?.textContent);
  check("join guard focuses Cancel", (guardFocus ?? "").includes("Vazgeç") || (guardFocus ?? "").includes("İptal"), guardFocus ?? "");
  await page.screenshot({ path: join(shotDir, "10-join-guard.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // add to call: friends list from the fixture
  await page.click('[data-testid="open-add"]');
  await page.waitForSelector('[data-testid="add-call-candidate"]', { timeout: 5000 });
  const candidates = await page.locator('[data-testid="add-call-candidate"]').count();
  check("add-to-call lists friends minus the peer", candidates === 4, String(candidates));
  await page.fill('[role="dialog"] input', "zzzz");
  const noMatch = await page.textContent('[data-testid="add-call-empty"]');
  check("add-to-call: no-match copy names the query", (noMatch ?? "").includes("zzzz"), noMatch ?? "");
  await page.fill('[role="dialog"] input', "");
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "11-add-call.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // watch party band + refusal + picker results
  await page.click('[data-testid="watch-refuse"]');
  await page.waitForSelector('[data-testid="watch-box"] [role="alert"]');
  const band = await css(page, '[data-testid="watch-band"]', ["background-color", "border-top-width", "border-top-left-radius"]);
  check("watch band = surface tone, borderless, radius 16", band["background-color"] === "rgb(23, 23, 23)" && band["border-top-width"] === "0px" && band["border-top-left-radius"] === "16px", JSON.stringify(band));
  await page.locator('[data-testid="sec-watch"]').screenshot({ path: join(shotDir, "12-watch.png") });
  await page.click('[data-testid="watch-picker-results"]');
  await page.waitForSelector('[role="dialog"] ul button');
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "13-watch-picker.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // the remaining panel states, for the record
  for (const s of ["joining", "reconnecting", "error"]) {
    await page.click(`[data-testid="status-${s}"]`);
    await page.waitForTimeout(250);
    await page.locator('[data-testid="sidebar-column"]').screenshot({ path: join(shotDir, `14-panel-${s}.png`) });
  }
  await page.click('[data-testid="status-connected"]');
  await page.click('[data-testid="share-toggle"]');
  for (const a of ["live", "waiting", "noSound", "failed"]) {
    await page.click(`[data-testid="audio-${a}"]`);
    await page.waitForTimeout(250);
    await page.locator('[data-testid="sidebar-column"]').screenshot({ path: join(shotDir, `15-share-audio-${a}.png`) });
  }
  const noSoundTone = await page.getAttribute('[data-testid="voice-panel"] [data-testid="share-audio-status"]', "data-tone");
  check("share audio box follows the state (failed → warn)", noSoundTone === "warn", noSoundTone ?? "");

  // per-user volume: right-click a remote row → the design-system slider,
  // keyboard-adjustable inside the menu; Esc closes the menu.
  await page.locator('[data-testid="voice-participant"]').nth(1).click({ button: "right" });
  await page.waitForSelector('[data-testid="participant-volume"] [role="slider"]');
  const volSlider = page.locator('[data-testid="participant-volume"] [role="slider"]');
  await volSlider.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const vol = [await volSlider.getAttribute("aria-valuenow"), await volSlider.getAttribute("aria-valuetext")];
  check("volume slider: arrows step 5% inside the menu", vol[0] === "0.9" && vol[1] === "90%", vol.join(" / "));
  await page.screenshot({ path: join(shotDir, "21-participant-menu.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'), null, { timeout: 2000 });

  check("default mode: zero console errors/warnings", messages.length === 0, messages.join(" || "));
  await context.close();
}

// ── 2. desktop picker mode (Electron source grid + three sound options) ─────
{
  const { page, context, messages } = await openPage("?picker=desktop");
  await page.click('[data-testid="open-picker"]');
  await page.waitForSelector('[role="dialog"] [data-testid="source-card"]', { timeout: 5000 });
  const cards = await page.locator('[role="dialog"] [data-testid="source-card"]').count();
  check("desktop picker lists windows + screens", cards === 6, String(cards));
  await page.click('[role="dialog"] [data-testid="source-card"] >> nth=0');
  await page.waitForTimeout(300);
  const selected = await css(page, '[role="dialog"] [data-testid="source-card"][aria-pressed="true"]', ["background-color", "box-shadow"]);
  check("selected card = coral wash + inset coral line", selected["background-color"] === "rgba(255, 132, 100, 0.12)" && selected["box-shadow"].includes("inset"), JSON.stringify(selected));
  const options = await page.$$eval('[role="dialog"] [role="radiogroup"] [role="radio"]', (els) =>
    els.map((e) => `${e.getAttribute("data-testid")}:${e.getAttribute("aria-checked")}:${e.hasAttribute("disabled")}`),
  );
  check(
    "three sound options; a window starts on 'only this app'",
    options.length >= 3 && options.includes("share-audio-option-app:true:false"),
    options.join(" "),
  );
  await page.click('[role="dialog"] [data-testid="source-card"] >> nth=4');
  await page.waitForTimeout(250);
  const screenOptions = await page.$$eval('[role="dialog"] [data-testid^="share-audio-option-"]', (els) =>
    els.map((e) => `${e.getAttribute("data-testid")}:${e.getAttribute("aria-checked")}:${e.hasAttribute("disabled")}`),
  );
  check(
    "a screen disables 'only this app' and starts on system sound",
    screenOptions.includes("share-audio-option-app:false:true") && screenOptions.includes("share-audio-option-system:true:false"),
    screenOptions.join(" "),
  );
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "16-picker-desktop.png") });
  check("desktop picker mode: zero console errors/warnings", messages.length === 0, messages.join(" || "));
  await context.close();
}

// ── 3. failure states: camera denied, no devices, friends loading / error ──
{
  const { page, context, messages } = await openPage("?nocam=1&nodevices=1&friends=error");
  await page.click('[data-testid="open-preview"]');
  await page.waitForSelector('[data-testid="camera-preview"][data-state="error"]', { timeout: 5000 });
  check("camera denied → error state with retry", (await page.locator('[data-testid="camera-preview"] button').count()) === 1);
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "17-camera-denied.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.click('[data-testid="open-devices"]');
  await page.waitForSelector('[data-testid="device-group-videoinput"] p');
  const empty = await page.textContent('[data-testid="device-group-videoinput"] p');
  const audioRows = await page.locator('[data-testid="device-group-audioinput"] [role="radio"]').count();
  check(
    "no devices → camera empty-state copy; audio keeps its system-default row",
    (empty ?? "").includes("Kamera adları") && audioRows === 1,
    `${empty} / audio rows ${audioRows}`,
  );
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "18-devices-empty.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.click('[data-testid="open-add"]');
  await page.waitForSelector('[data-testid="add-call-error"]', { timeout: 15000 });
  check("friends fail → error + retry", true);
  await animationsSettle(page, '[role="dialog"]');
  await page.screenshot({ path: join(shotDir, "19-add-call-error.png") });
  // The 503 is answered by the harness's fetch stub (no real request), so even
  // the failure scenario must leave the console clean.
  check("failure mode: zero console errors/warnings", messages.length === 0, messages.join(" || "));
  await context.close();
}
{
  const { page, context, messages } = await openPage("?friends=loading");
  await page.click('[data-testid="open-add"]');
  await page.waitForSelector('[data-testid="add-call-loading"]', { timeout: 5000 });
  check("friends loading → skeleton rows, not 'no friends'", (await page.locator('[data-testid="add-call-empty"]').count()) === 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shotDir, "20-add-call-loading.png") });
  check("loading mode: zero console errors/warnings", messages.length === 0, messages.join(" || "));
  await context.close();
}

// ── 5. real sidebar width (w-60 = 240px), TR + EN: the DM dock never cuts its state ──
for (const lng of ["tr", "en"]) {
  const { page, context, messages } = await openPage(`?lng=${lng}`);
  await page.click('[data-testid="status-connected"]');
  await page.waitForTimeout(250);
  const widths = await page.$$eval('[data-testid="sidebar-column"], [data-testid^="dock-"]', (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().width)),
  );
  check(
    `[${lng}] harness columns are the real sidebar width (240px)`,
    widths.length === 5 && widths.every((w) => w === 240),
    widths.join(","),
  );

  /** Every line must show its whole text: no ellipsis, no clamp overflow. */
  const fits = (selector) =>
    page.$$eval(selector, (els) =>
      els.map((e) => ({
        text: e.textContent,
        // A truncated or clamped line holds more content than its box on one axis.
        clipped: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1,
        lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)),
      })),
    );
  const states = [];
  for (const camera of [false, true]) {
    if (camera) {
      await page.click('[data-testid="stage-camera"]');
      await page.waitForTimeout(250);
    }
    states.push(...(await fits('[data-testid^="dock-"] [data-testid="call-dock-status"]')));
  }
  states.push(...(await fits('[data-testid^="dock-"] [data-testid="call-dock-title"]')));
  const expected =
    lng === "tr"
      ? ["Çalıyor", "Sesli bağlantı kuruldu", "Görüntülü bağlantı kuruldu", "Başka cihazda aramadasın"]
      : ["Ringing", "Voice connected", "Video connected", "on another"];
  const texts = states.map((s) => s.text ?? "");
  check(
    `[${lng}] dock status + seat lines covered (ringing, voice, video, elsewhere, vacant)`,
    states.length === 6 && expected.every((e) => texts.some((t) => t.includes(e))),
    texts.join(" | "),
  );
  const cut = states.filter((s) => s.clipped || s.lines > 2);
  check(
    `[${lng}] no dock status/seat line is cut at 240px`,
    cut.length === 0,
    JSON.stringify(cut.length ? cut : states.map((s) => `${s.text}:${s.lines}l`)),
  );
  // Put the camera back so the rest of the page is as it started.
  await page.click('[data-testid="stage-camera"]');

  // The voice panel's own lines at the same width, through every FSM state.
  const panel = [];
  for (const status of ["joining", "connected", "reconnecting", "error", "leaving"]) {
    await page.click(`[data-testid="status-${status}"]`);
    await page.waitForTimeout(350);
    panel.push(...(await fits('[data-testid="voice-panel"] [role="status"]')));
  }
  const panelCut = panel.filter((s) => s.clipped);
  check(
    `[${lng}] voice panel status line is never cut at 240px`,
    panel.length === 5 && panelCut.length === 0,
    JSON.stringify(panelCut.length ? panelCut : panel.map((s) => s.text)),
  );
  await page.click('[data-testid="status-connected"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotDir, `21-panel-240-${lng}.png`) });
  check(`[${lng}] sidebar-width mode: zero console errors/warnings`, messages.length === 0, messages.join(" || "));
  await context.close();
}

// ── 6. keyboard focus is VISIBLE on video tiles (sampled pixels, not classes) ──
{
  const { page, context, messages } = await openPage("");
  await page.waitForTimeout(600);
  /**
   * Read RGB pixels out of a real VIEWPORT screenshot, at points measured from
   * the element's own edges in page pixels (x < 0 = from the right edge). The
   * viewport shot avoids a fractional clip box shaving off the 2px edge itself.
   */
  async function pixels(selector, points) {
    const png = await page.screenshot();
    const rect = await page.$eval(selector, (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    });
    return page.evaluate(
      async ({ b64, pts, r }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return pts.map(([px, fy]) => {
          // Sample the CENTRE of the device pixel `px` steps in from the edge.
          const x = px < 0 ? Math.round(r.right) + px : Math.round(r.left) + px;
          const y = Math.round(r.top + fy * (r.bottom - r.top));
          return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
        });
      },
      { b64: png.toString("base64"), pts: points, r: rect },
    );
  }
  const white = (p) => p.every((v) => v >= 225);
  const dark = (p) => p.every((v) => v <= 40);
  for (const [wrap, tile, label] of [
    ["tile-camera", "camera-tile", "camera tile (video)"],
    ["tile-share", "screen-share-tile", "screen-share tile (video)"],
    ["tile-avatar-speaking", "avatar-tile", "speaking avatar tile"],
  ]) {
    const sel = `[data-testid="${wrap}"] [data-testid="${tile}"]`;
    await page.locator(sel).scrollIntoViewIfNeeded();
    // Edge pixels: the outer 2px on the left and right (x = 1, w-2) and the
    // black keyline just inside it (x = 3).
    const pts = [
      [1, 0.5],
      [-2, 0.5],
      [3, 0.5],
    ];
    const before = await pixels(sel, pts);
    // Reach the tile BY KEYBOARD (Shift+Tab away, Tab back) so :focus-visible
    // is the browser's own decision, not a forced class.
    await page.focus(sel);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const state = await page.$eval(sel, (el) => ({
      active: document.activeElement === el,
      visible: el.matches(":focus-visible"),
    }));
    await page.waitForTimeout(350);
    const ring = await css(page, `${sel} > [data-testid="tile-focus-ring"]`, ["opacity", "z-index"]);
    const after = await pixels(sel, pts);
    check(
      `focus-visible on the ${label} paints a white edge above the picture`,
      state.active &&
        state.visible &&
        ring.opacity === "1" &&
        white(after[0]) &&
        white(after[1]) &&
        dark(after[2]) &&
        !white(before[0]),
      JSON.stringify({ state, ring, before, after }),
    );
    await page.locator(`[data-testid="${wrap}"]`).screenshot({ path: join(shotDir, `22-focus-${tile}.png`) });
    // Blur → the overlay fades back out.
    await page.$eval(sel, (el) => el.blur());
    await page.waitForTimeout(350);
    const gone = await css(page, `${sel} > [data-testid="tile-focus-ring"]`, ["opacity"]);
    check(`${label}: focus mark fades out on blur`, gone.opacity === "0", gone.opacity);
  }
  check("tile focus mode: zero console errors/warnings", messages.length === 0, messages.join(" || "));
  await context.close();
}

// ── 7. source picker at the real window sizes: the sound choice is never below the fold ──
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 940, height: 560 },
]) {
  const tag = `${viewport.width}x${viewport.height}`;
  const { page, context, messages } = await openPage("?picker=desktop&windows=12", { viewport });
  await page.click('[data-testid="open-picker"]');
  await page.waitForSelector('[role="dialog"] [data-testid="source-card"]', { timeout: 5000 });
  await animationsSettle(page, '[role="dialog"]');
  await page.click('[role="dialog"] [data-testid="source-card"] >> nth=0');
  await page.waitForTimeout(300);
  const layout = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) };
    };
    const pane = document.querySelector('[data-testid="share-settings-pane"]');
    const sources = document.querySelector('[data-testid="source-pane"]');
    const options = [...document.querySelectorAll('[role="dialog"] [data-testid^="share-audio-option-"]')].map((e) => {
      const b = e.getBoundingClientRect();
      return { id: e.getAttribute("data-testid"), top: Math.round(b.top), bottom: Math.round(b.bottom) };
    });
    return {
      vh: window.innerHeight,
      cards: document.querySelectorAll('[role="dialog"] [data-testid="source-card"]').length,
      dialog: r('[data-testid="source-picker"]'),
      pane: r('[data-testid="share-settings-pane"]'),
      sources: r('[data-testid="source-pane"]'),
      start: r('[data-testid="source-start"]'),
      resolution: r('[data-testid="share-resolution"]'),
      framerate: r('[data-testid="share-framerate"]'),
      options,
      paneScroll: pane ? [pane.scrollTop, pane.scrollHeight, pane.clientHeight] : null,
      sourceScroll: sources ? [sources.scrollHeight, sources.clientHeight] : null,
    };
  });
  const within = (el, box) => Boolean(el && box && el.top >= box.top - 1 && el.bottom <= box.bottom + 1);
  check(`[${tag}] picker lists 16 windows + 2 screens`, layout.cards === 18, String(layout.cards));
  check(
    `[${tag}] picker fits the window`,
    Boolean(layout.dialog && layout.dialog.top >= 0 && layout.dialog.bottom <= layout.vh),
    JSON.stringify(layout.dialog),
  );
  check(
    `[${tag}] two panes: settings beside the sources`,
    Boolean(layout.pane && layout.sources && layout.pane.left >= layout.sources.right),
    JSON.stringify({ pane: layout.pane, sources: layout.sources }),
  );
  check(
    `[${tag}] all three sound options are in view without scrolling`,
    layout.options.length === 3 && layout.options.every((o) => within(o, layout.pane) && o.bottom <= layout.vh),
    JSON.stringify({ options: layout.options, pane: layout.pane }),
  );
  const hints = await page.$$eval('[role="dialog"] [data-testid^="share-audio-option-"]', (els) =>
    els.map((e) => {
      const d = document.getElementById(e.getAttribute("aria-describedby") ?? "");
      const shown = d?.querySelector("[data-hint-visible]") !== null && d?.querySelector("[data-hint-visible]") !== undefined;
      return { id: e.getAttribute("data-testid"), checked: e.getAttribute("aria-checked"), described: (d?.textContent ?? "").length > 10, shown };
    }),
  );
  check(
    `[${tag}] only the chosen option shows its hint; every option keeps its accessible description`,
    hints.every((h) => h.described) && hints.filter((h) => h.shown).length === 1 && hints.find((h) => h.shown)?.checked === "true",
    JSON.stringify(hints),
  );
  // Worst case: the longest hint (system sound) is the chosen one.
  await page.click('[role="dialog"] [data-testid="share-audio-option-system"]');
  await page.waitForTimeout(200);
  const worst = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="share-settings-pane"]').getBoundingClientRect();
    return [...document.querySelectorAll('[role="dialog"] [data-testid^="share-audio-option-"]')].map((e) => {
      const b = e.getBoundingClientRect();
      return { id: e.getAttribute("data-testid"), inView: b.top >= p.top - 1 && b.bottom <= p.bottom + 1, bottom: Math.round(b.bottom), paneBottom: Math.round(p.bottom) };
    });
  });
  check(
    `[${tag}] with the longest hint chosen (system sound) all three options are still in view`,
    worst.length === 3 && worst.every((o) => o.inView),
    JSON.stringify(worst),
  );
  await page.screenshot({ path: join(shotDir, `26-picker-${tag}-system.png`) });
  await page.click('[role="dialog"] [data-testid="share-audio-option-app"]');
  await page.waitForTimeout(200);
  check(`[${tag}] the start button is in view`, Boolean(layout.start && layout.start.bottom <= layout.vh), JSON.stringify(layout.start));
  if (viewport.width === 1280) {
    check(
      `[${tag}] resolution + frame rate are in view too`,
      within(layout.resolution, layout.pane) && within(layout.framerate, layout.pane),
      JSON.stringify({ resolution: layout.resolution, framerate: layout.framerate, pane: layout.pane }),
    );
  } else {
    // At the 940×560 minimum the quality block may need the settings pane's own
    // scroll; the sound choice above must not, and quality must stay reachable.
    await page.locator('[data-testid="share-framerate"]').scrollIntoViewIfNeeded();
    const reach = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="share-framerate"]').getBoundingClientRect();
      const p = document.querySelector('[data-testid="share-settings-pane"]').getBoundingClientRect();
      return b.top >= p.top - 1 && b.bottom <= p.bottom + 1;
    });
    check(`[${tag}] frame rate is reachable inside the settings pane`, reach, JSON.stringify(layout.paneScroll));
    await page.locator('[data-testid="share-settings-pane"]').evaluate((el) => el.scrollTo({ top: 0 }));
  }
  check(
    `[${tag}] a long window list scrolls in the source pane`,
    Boolean(layout.sourceScroll && layout.sourceScroll[0] > layout.sourceScroll[1]),
    JSON.stringify(layout.sourceScroll),
  );
  const paneTopBefore = layout.pane.top;
  await page.locator('[data-testid="source-pane"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(150);
  const paneTopAfter = await page.$eval('[data-testid="share-settings-pane"]', (el) =>
    Math.round(el.getBoundingClientRect().top),
  );
  check(
    `[${tag}] scrolling the sources leaves the sound choice in place`,
    paneTopAfter === paneTopBefore,
    `${paneTopBefore} → ${paneTopAfter}`,
  );
  await page.locator('[data-testid="source-pane"]').evaluate((el) => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotDir, `25-picker-${tag}.png`) });
  check(`[${tag}] picker mode: zero console errors/warnings`, messages.length === 0, messages.join(" || "));
  await context.close();
}

// ── 4. reduced motion ───────────────────────────────────────────────────────
{
  const { page, context, messages } = await openPage("", { reducedMotion: "reduce" });
  await page.click('[data-testid="incoming-audio"]');
  await page.waitForSelector('[data-testid="incoming-call-halo"]');
  const halo = await css(page, '[data-testid="incoming-call-halo"]', ["animation-name"]);
  check("reduced motion: incoming halo does not loop", halo["animation-name"] === "none", halo["animation-name"]);
  await page.click('[data-testid="incoming-close"]');
  const rowDuration = await page.locator('[data-testid="voice-participant"]').first().evaluate((el) => getComputedStyle(el).transitionDuration);
  check("reduced motion: transitions collapse", rowDuration.split(",")[0].trim() === "1e-05s" || rowDuration.startsWith("0.00001s") || parseFloat(rowDuration) < 0.001, rowDuration);
  const tilePulse = await page.click('[data-testid="speak-2"]').then(() =>
    page.locator('[data-testid="tile-avatar-focused"] [data-testid="avatar-tile"] span.border-accent').evaluate((el) => getComputedStyle(el).animationName),
  );
  check("reduced motion: speaking ring does not pulse", tilePulse === "none", tilePulse);
  // framer-motion's DEV build announces the OS setting once
  // (VisualElement.mjs: `if (process.env.NODE_ENV !== "production") warnOnce(...)`)
  // — it is the library confirming reduced motion is honoured, stripped from
  // production. That exact line is the only message tolerated here.
  const FRAMER_RM = "You have Reduced Motion enabled on your device. Animations may not appear as expected.";
  const rmUnexpected = messages.filter((m) => m !== `warning: ${FRAMER_RM}`);
  check("reduced-motion mode: zero console errors/warnings (besides framer's dev notice)", rmUnexpected.length === 0, rmUnexpected.join(" || "));
  await context.close();
}

await browser.close();
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
