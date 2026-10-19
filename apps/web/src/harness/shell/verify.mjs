/* global document, getComputedStyle, HTMLElement, process, console, setTimeout, window */
/**
 * SHELL HARNESS DRIVER — dev-only proof script for the M16 app-frame pass.
 *
 * Drives /harness-shell.html with system Chrome (headless) and asserts what a
 * screenshot cannot: the computed tokens on the real components, hover / press /
 * focus-visible state changes, open/close animations that actually FINISH,
 * keyboard paths, reduced motion, and a clean console on every scene.
 *
 *   pnpm --filter @demli/web exec vite --port <free port> --strictPort
 *   npx -y -p playwright-core@1.48.2 node apps/web/src/harness/shell/verify.mjs http://127.0.0.1:<port> [shotDir]
 *
 * playwright-core is deliberately NOT a repo dependency (dev-only, ~10 MB); the
 * line above fetches it for the run. Exit code 1 on any failed check.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

const base = process.argv[2] ?? "http://127.0.0.1:57391";
const shotDir = process.argv[3] ?? null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

const results = [];
const consoleProblems = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function open(
  scene,
  { width = 1440, height = 900, reducedMotion = "no-preference", lang, query = "", touch = false } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion,
    deviceScaleFactor: 1,
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleProblems.push(`[${scene}] ${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => consoleProblems.push(`[${scene}] pageerror: ${err.message}`));
  await page.goto(`${base}/harness-shell.html?scene=${scene}${lang ? `&lang=${lang}` : ""}${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
  await page.waitForTimeout(900);
  return { page, context };
}

const style = (page, selector, props) =>
  page.evaluate(
    ([sel, keys]) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return Object.fromEntries(keys.map((k) => [k, cs.getPropertyValue(k)]));
    },
    [selector, props],
  );

/**
 * Resolves once every FINITE running Web Animation (CSS animations included) has
 * finished. Infinite ones (a spinner, a skeleton pulse, typing dots) are loops by
 * design and are excluded — awaiting them would never return.
 */
const finiteAnimations = () =>
  document
    .getAnimations()
    .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Infinity)));
const animationsSettle = (page) =>
  page.evaluate(async (src) => {
    const finite = new Function(`return (${src})`)();
    // Loop: a finished exit can START the next animation (AnimatePresence
    // mode="wait" runs exit, then enter), so wait until nothing finite is left
    // running — or give up after 3s and report what is still going.
    const running = finite();
    const deadline = Date.now() + 3000;
    let pending = running;
    while (pending.length > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.all(pending.map((a) => a.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      pending = finite().filter((a) => a.playState === "running");
    }
    const still = finite().filter((a) => a.playState === "running");
    return {
      count: running.length,
      unfinished: still.length,
      names: still.map((a) => {
        const timing = a.effect?.getComputedTiming();
        const target = a.effect?.target;
        return `${a.animationName ?? "waapi"}@${target?.tagName}.${String(target?.className).slice(0, 40)} t=${Math.round(Number(a.currentTime))}/${Math.round(Number(timing?.endTime))} rate=${a.playbackRate}`;
      }),
    };
  }, finiteAnimations.toString());

async function shot(page, name) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` });
}

// ── 1. Desktop shell: tokens, fonts, row states, rail pill, tooltip ─────────
{
  const { page, context } = await open("shell");

  const frame = await style(page, "[data-shell=desktop]", ["background-color", "gap"]);
  check("page is the Koyu Masa black", frame?.["background-color"] === "rgb(0, 0, 0)", frame?.["background-color"]);
  check("islands are separated by 8px of page", frame?.gap === "8px", frame?.gap);

  const island = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Kanallar"]');
    const column = nav?.parentElement;
    const islandEl = column?.parentElement;
    if (!column || !islandEl) return null;
    return {
      bg: getComputedStyle(column).backgroundColor,
      radius: getComputedStyle(islandEl).borderTopLeftRadius,
    };
  });
  check("channel island = base tone #0d0d0d", island?.bg === "rgb(13, 13, 13)", island?.bg);
  check("channel island radius = card (24px)", island?.radius === "24px", island?.radius);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const heading = document.querySelector("nav[aria-label='Kanallar']")?.parentElement?.querySelector(".font-display");
    const row = document.querySelector("[aria-current='true']");
    return {
      heading: heading ? getComputedStyle(heading).fontFamily : null,
      row: row ? getComputedStyle(row).fontFamily : null,
      onest: document.fonts.check('600 16px "Onest"'),
      inter: document.fonts.check('500 14px "Inter"'),
    };
  });
  check("server header uses Onest (display)", /^"?Onest/.test(fonts.heading ?? ""), fonts.heading);
  check("rows use Inter (body)", /^"?Inter/.test(fonts.row ?? ""), fonts.row);
  check("Onest + Inter faces actually loaded", fonts.onest && fonts.inter, `onest=${fonts.onest} inter=${fonts.inter}`);

  // Selected channel row = coral wash + light-coral label.
  const selected = await page.evaluate(() => {
    const row = [...document.querySelectorAll("nav[aria-label='Kanallar'] button[aria-current='true']")][0];
    if (!row) return null;
    const cs = getComputedStyle(row);
    return { bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius };
  });
  check(
    "selected row: accent-soft wash",
    selected?.bg === "rgba(255, 132, 100, 0.12)",
    selected?.bg,
  );
  check("selected row: accent-hover label", selected?.color === "rgb(255, 164, 140)", selected?.color);

  // Hover = tone change over 200ms, no transform.
  const rowSelector = "nav[aria-label='Kanallar'] button:has(> span.truncate)";
  const target = page.locator("nav[aria-label='Kanallar'] button", { hasText: "eski-plan" }).first();
  const restBg = await target.evaluate((el) => getComputedStyle(el).backgroundColor);
  const transition = await target.evaluate((el) => ({
    duration: getComputedStyle(el).transitionDuration,
    property: getComputedStyle(el).transitionProperty,
  }));
  await target.hover();
  await page.waitForTimeout(320);
  const hover = await target.evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    transform: getComputedStyle(el).transform,
  }));
  check("row rest = transparent", restBg === "rgba(0, 0, 0, 0)", restBg);
  check("row hover = surface tone #171717", hover.bg === "rgb(23, 23, 23)", hover.bg);
  check("row hover moves nothing (no transform)", hover.transform === "none", hover.transform);
  check(
    "row hover transition is the 200ms tone step",
    transition.duration.split(",").every((d) => d.trim() === "0.2s") && /background-color/.test(transition.property),
    `${transition.property} / ${transition.duration}`,
  );
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(320);
  const pressed = await target.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.mouse.up();
  check("row pressed = raised-pressed #1f1f1f", pressed === "rgb(31, 31, 31)", pressed);
  void rowSelector;

  // Focus-visible via keyboard: an inset coral ring.
  await page.mouse.move(5, 890);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(250);
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { text: el.textContent?.trim(), shadow: getComputedStyle(el).boxShadow, visible: el.matches(":focus-visible") } : null;
  });
  // The ring colour is `accent/70`, which Chrome serialises as oklab(); assert a
  // visible (non-transparent) 2px INSET ring, not a particular colour syntax.
  const ring = (focus?.shadow ?? "").split(/,(?![^(]*\))/).find((part) => /2px inset/.test(part)) ?? "";
  check(
    "keyboard focus shows the inset coral ring",
    Boolean(focus?.visible) && ring !== "" && !/rgba\(0, 0, 0, 0\)/.test(ring) && /0\.7\)/.test(ring),
    `${focus?.text} :: ${ring}`,
  );

  // Rail: selected pill is tall + coral; hovering another tile grows ITS pill.
  const pills = await page.evaluate(() =>
    [...document.querySelectorAll("[data-rail-pill]")].map((el) => ({
      state: el.getAttribute("data-rail-pill"),
      h: getComputedStyle(el).height,
      bg: getComputedStyle(el).backgroundColor,
      timing: getComputedStyle(el).transitionTimingFunction.slice(0, 12),
    })),
  );
  const sel = pills.find((p) => p.state === "selected");
  check("rail: one selected pill, 36px, coral", pills.filter((p) => p.state === "selected").length === 1 && sel?.h === "36px" && sel?.bg === "rgb(255, 132, 100)", JSON.stringify(sel));
  check("rail pill rides the authored spring curve", sel?.timing.startsWith("linear("), sel?.timing);
  const unreadPill = pills.find((p) => p.state === "unread");
  check("rail: unread pill is short + white", unreadPill?.h === "8px" && unreadPill?.bg === "rgb(229, 229, 229)", JSON.stringify(unreadPill));

  const idleTile = page.getByRole("button", { name: "Kitap Kulübü" });
  await idleTile.hover();
  await page.waitForTimeout(800);
  const grown = await idleTile.evaluate((el) => {
    const pill = el.closest(".group")?.querySelector("[data-rail-pill]");
    return pill ? getComputedStyle(pill).height : null;
  });
  check("rail: hovering a tile grows its pill to 20px", grown === "20px", String(grown));
  const tooltip = await page.waitForSelector("[role=tooltip]", { timeout: 2000 }).catch(() => null);
  const tipText = tooltip ? await tooltip.textContent() : null;
  const tipStyle = await page.evaluate(() => {
    const tip = document.querySelector("[data-radix-popper-content-wrapper] > div");
    return tip ? { filter: getComputedStyle(tip).backdropFilter, bg: getComputedStyle(tip).backgroundColor } : null;
  });
  check("rail tile tooltip names the server", tipText?.includes("Kitap Kulübü") ?? false, String(tipText));
  check("tooltip is strong glass (92% + blur 10px)", tipStyle?.filter === "blur(10px)" && tipStyle?.bg === "rgba(23, 23, 23, 0.92)", JSON.stringify(tipStyle));
  await shot(page, "verify-shell-hover");

  // Collapse a section: chevron turns, rows hide (active row stays), reopening fades rows in.
  // (The press check above OPENED eski-plan; read #sohbet again first so the
  // channel being read is inside the section we collapse.)
  await page.locator("nav[aria-label='Kanallar'] button", { hasText: /^sohbet/ }).first().click();
  await page.mouse.move(700, 450);
  const header = page.getByRole("button", { name: /Metin kanalları bölümünü daralt/ });
  await header.click();
  await page.waitForTimeout(300);
  const collapsed = await page.evaluate(() => ({
    chevron: document.querySelector("[data-collapsed='true']") !== null,
    rows: [...(document.querySelector("nav[aria-label='Kanallar'] > section")?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim()),
  }));
  check(
    "collapsed section keeps only the channel you are reading",
    collapsed.chevron && collapsed.rows.some((t) => t?.startsWith("sohbet")) && !collapsed.rows.some((t) => t?.startsWith("film-listesi")),
    collapsed.rows.join(" | "),
  );
  await page.getByRole("button", { name: /Metin kanalları bölümünü genişlet/ }).click();
  const revealing = await page.evaluate(() =>
    document.querySelector("nav[aria-label='Kanallar'] > section .animate-fade-in") !== null,
  );
  const settled = await animationsSettle(page);
  check("expanding fades the rows in (and the animation finishes)", revealing && settled.unfinished === 0, JSON.stringify(settled));

  // Counts: mention badge coral with dark ink.
  const badge = await page.evaluate(() => {
    const el = [...document.querySelectorAll("nav[aria-label='Kanallar'] span.tabular-nums")].find((s) => s.textContent === "3");
    return el ? { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color } : null;
  });
  check("mention count = coral fill, dark ink", badge?.bg === "rgb(255, 132, 100)" && badge?.color === "rgb(23, 23, 23)", JSON.stringify(badge));

  // Rail badges sit on the TILE corner, inside the rail — never clipped by the
  // server scroller, and the scroller cannot be moved sideways.
  const rail = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll("div.overflow-y-auto")].find((d) => d.querySelector("[data-rail-pill]"));
    if (!scroller) return null;
    const badges = [...scroller.querySelectorAll("span.tabular-nums")].map((b) => {
      const tile = b.parentElement?.querySelector("button");
      return {
        text: b.textContent,
        right: Math.round(b.getBoundingClientRect().right),
        overhang: tile ? Math.round(b.getBoundingClientRect().right - tile.getBoundingClientRect().right) : null,
      };
    });
    const before = scroller.scrollLeft;
    scroller.scrollLeft = 10;
    const after = scroller.scrollLeft;
    scroller.scrollLeft = before;
    return {
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      right: Math.round(scroller.getBoundingClientRect().right),
      scrolledTo: after,
      badges,
      overflowX: getComputedStyle(scroller).overflowX,
    };
  });
  check(
    "rail: every count badge fits inside the scroller (nothing clipped)",
    rail !== null && rail.badges.length >= 2 && rail.badges.every((b) => b.right <= rail.right),
    JSON.stringify(rail?.badges),
  );
  check(
    "rail: badges overhang their tile corner by the same 4px",
    rail !== null && rail.badges.every((b) => b.overhang === 4),
    JSON.stringify(rail?.badges.map((b) => b.overhang)),
  );
  check(
    "rail: server column cannot scroll sideways",
    rail !== null && rail.scrollWidth === rail.clientWidth && rail.scrolledTo === 0 && rail.overflowX === "hidden",
    `client=${rail?.clientWidth} scroll=${rail?.scrollWidth} scrollLeft→${rail?.scrolledTo} overflow-x=${rail?.overflowX}`,
  );

  // User footer: the identity block gets real width (it was 38px).
  const footer = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Kullanıcı menüsü"]');
    const spans = btn ? [...btn.querySelectorAll("span.block")] : [];
    return btn
      ? { block: Math.round(btn.getBoundingClientRect().width), lines: spans.map((s) => ({ text: s.textContent, width: s.clientWidth })) }
      : null;
  });
  check(
    "user footer: identity block ≥ 90px, name + status lines ≥ 80px",
    footer !== null && footer.block >= 90 && footer.lines.length === 2 && footer.lines.every((l) => l.width >= 80),
    JSON.stringify(footer),
  );
  await page.getByRole("button", { name: "Kullanıcı menüsü" }).hover();
  const statusTip = await page.waitForSelector("[role=tooltip]", { timeout: 2000 }).catch(() => null);
  const statusTipText = statusTip ? await statusTip.textContent() : null;
  check(
    "user footer: hovering the name shows the whole custom status",
    statusTipText?.includes("Film gecesi 21:30'da") ?? false,
    String(statusTipText),
  );
  await page.mouse.move(700, 450);

  await context.close();
}

// ── 1b. Load states: a failed / pending fetch is never shown as "empty" ─────
{
  // Server details refused once (server unreachable), then served on retry.
  const { page, context } = await open("fail");
  const failed = await page.evaluate(() => {
    const nav = document.querySelector("nav[aria-label='Kanallar']");
    const aside = document.querySelector("aside[aria-label]");
    const band = nav?.querySelector("[role=alert]") ?? null;
    return {
      nav: nav?.textContent ?? "",
      navAlert: band !== null,
      h2: aside?.querySelector("h2")?.textContent ?? null,
      aside: aside?.textContent ?? "",
      band: band ? getComputedStyle(band).backgroundColor : null,
    };
  });
  check(
    "fetch failed: channel column shows the retry band, not 'Henüz kanal yok'",
    failed.navAlert &&
      failed.nav.includes("Kanallar yüklenemedi") &&
      failed.nav.includes("Sunucuya ulaşılamıyor. Bağlantını kontrol edip tekrar dene.") &&
      !failed.nav.includes("Henüz kanal yok") &&
      !failed.nav.includes("Kanal oluştur"),
    failed.nav.slice(0, 160),
  );
  check("fetch failed: band is the danger wash token", failed.band === "rgba(255, 111, 181, 0.12)", String(failed.band));
  check(
    "fetch failed: roster drops the count ('Üyeler', never 'Üyeler — 0') and offers retry",
    failed.h2 === "Üyeler" && failed.aside.includes("Üyeler yüklenemedi"),
    `${failed.h2} :: ${failed.aside.slice(0, 120)}`,
  );
  await shot(page, "verify-fetch-failed");
  await page.locator("nav[aria-label='Kanallar']").getByRole("button", { name: "Tekrar dene" }).click();
  await page
    .waitForFunction(() => document.querySelector("nav[aria-label='Kanallar']")?.textContent?.includes("salon"), null, { timeout: 3000 })
    .catch(() => null);
  const healed = await page.evaluate(() => ({
    nav: document.querySelector("nav[aria-label='Kanallar']")?.textContent ?? "",
    h2: document.querySelector("aside[aria-label] h2")?.textContent ?? null,
  }));
  check(
    "retry really refetches: channels + roster count arrive, band gone",
    healed.nav.includes("genel") && healed.nav.includes("salon") && !healed.nav.includes("yüklenemedi") && /^Üyeler — \d+$/.test(healed.h2 ?? ""),
    `${healed.h2} :: ${healed.nav.slice(0, 120)}`,
  );
  await context.close();
}
{
  // First fetch still in flight: skeletons, no count, no empty copy.
  const { page, context } = await open("loading");
  const loading = await page.evaluate(() => ({
    skeleton: document.querySelector("nav[aria-label='Kanallar'] [role=status][aria-label='Kanallar yükleniyor']") !== null,
    nav: document.querySelector("nav[aria-label='Kanallar']")?.textContent ?? "",
    h2: document.querySelector("aside[aria-label] h2")?.textContent ?? null,
  }));
  check(
    "first fetch pending: skeleton, roster without a count, no empty copy",
    loading.skeleton && loading.h2 === "Üyeler" && !loading.nav.includes("Henüz kanal yok"),
    JSON.stringify(loading).slice(0, 200),
  );
  await context.close();
}
{
  const { page, context } = await open("home-pending");
  const pending = await page.evaluate(() => ({
    skeleton: document.querySelector("[role=status][aria-label='Sohbetler yükleniyor']") !== null,
    empty: document.body.textContent?.includes("Henüz sohbet yok") ?? false,
  }));
  check("DMs pending: skeleton, never 'Henüz sohbet yok'", pending.skeleton && !pending.empty, JSON.stringify(pending));
  await context.close();
}
{
  const { page, context } = await open("home-fail");
  const failed = await page.evaluate(() => ({
    band: document.body.textContent?.includes("Sohbetler yüklenemedi") ?? false,
    empty: document.body.textContent?.includes("Henüz sohbet yok") ?? false,
  }));
  check("DMs fetch failed: retry band, never 'Henüz sohbet yok'", failed.band && !failed.empty, JSON.stringify(failed));
  await shot(page, "verify-dms-failed");
  await page.locator("[role=alert]", { hasText: "Sohbetler yüklenemedi" }).getByRole("button", { name: "Tekrar dene" }).click();
  const healed = await page
    .waitForFunction(() => !document.body.textContent?.includes("Sohbetler yüklenemedi"), null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const dmRow = await page.evaluate(() => document.body.textContent?.includes("Ece") ?? false);
  check("DM retry really refetches: the rows arrive", healed && dmRow, `healed=${healed} ece=${dmRow}`);
  await context.close();
}


// ── 2. Command menu: open/close motion + keyboard ──────────────────────────
{
  const { page, context } = await open("shell");
  await page.keyboard.press("Control+k");
  const dialog = await page.waitForSelector("[cmdk-dialog]", { timeout: 2000 }).catch(() => null);
  check("Ctrl+K opens the command menu", dialog !== null);
  const opening = await page.evaluate(() => {
    const content = document.querySelector("[cmdk-dialog]");
    const overlay = document.querySelector("[cmdk-overlay]");
    return {
      card: content ? getComputedStyle(content).animationName : null,
      scrim: overlay ? getComputedStyle(overlay).animationName : null,
    };
  });
  const settled = await animationsSettle(page);
  check(
    "open animation (card pop-in + scrim fade-in) runs and finishes",
    opening.card === "pop-in" && opening.scrim === "fade-in" && settled.unfinished === 0,
    `${JSON.stringify(opening)} ${JSON.stringify(settled)}`,
  );
  const card = await style(page, "[cmdk-root]", ["border-top-left-radius", "backdrop-filter", "background-color"]);
  check("palette card: radius 24 + strong glass", card?.["border-top-left-radius"] === "24px" && card?.["backdrop-filter"] === "blur(10px)", JSON.stringify(card));
  const first = await page.evaluate(() => {
    const item = document.querySelector("[cmdk-item][data-selected='true']");
    return item ? { text: item.textContent, bg: getComputedStyle(item).backgroundColor, color: getComputedStyle(item).color } : null;
  });
  check("selected palette row speaks the row language", first?.bg === "rgba(255, 132, 100, 0.12)" && first?.color === "rgb(255, 164, 140)", JSON.stringify(first));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(50);
  const second = await page.evaluate(() => document.querySelector("[cmdk-item][data-selected='true']")?.textContent);
  check("ArrowDown moves the selection", second !== first?.text, `${first?.text} → ${second}`);
  await page.keyboard.type("zzzz-yok");
  await page.waitForTimeout(100);
  const empty = await page.evaluate(() => document.querySelector("[cmdk-empty]")?.textContent ?? null);
  check("no match shows the empty state", empty?.includes("Sonuç bulunamadı") ?? false, String(empty));
  await shot(page, "verify-command-empty");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => document.querySelector("[cmdk-dialog]") === null);
  check("Esc closes it (exit animation then unmount)", closed);
  await context.close();
}

// ── 3. Reduced motion is respected ─────────────────────────────────────────
{
  const { page, context } = await open("shell", { reducedMotion: "reduce" });
  const pillDuration = await page.evaluate(() => {
    const pill = document.querySelector("[data-rail-pill='selected']");
    return pill ? getComputedStyle(pill).transitionDuration : null;
  });
  check("reduced motion: rail pill transition collapses to ~0", pillDuration === "1e-05s", String(pillDuration));
  await page.keyboard.press("Control+k");
  await page.waitForSelector("[cmdk-dialog]");
  const durations = await page.evaluate(() => {
    const content = document.querySelector("[cmdk-dialog]");
    const overlay = document.querySelector("[cmdk-overlay]");
    return [content, overlay].map((el) => (el ? getComputedStyle(el).animationDuration : null));
  });
  check(
    "reduced motion: palette open animations are instant",
    durations.every((d) => d === "1e-05s"),
    durations.join(","),
  );
  await context.close();
}

// ── 4. Narrow web shell: drawer motion, inert, focus in/out ────────────────
{
  const { page, context } = await open("mobile", { width: 390, height: 844 });
  const before = await page.evaluate(() => {
    const panel = document.querySelector("[role=dialog][data-state]");
    return panel ? { inert: panel.hasAttribute("inert"), state: panel.getAttribute("data-state") } : null;
  });
  check("closed drawer is inert (not in the Tab order)", before?.inert === true && before.state === "closed", JSON.stringify(before));
  const menu = page.getByRole("button", { name: "Menüyü aç" });
  await menu.click();
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const panel = document.querySelector("[role=dialog][data-state='open']");
    return panel
      ? {
          inert: panel.hasAttribute("inert"),
          transform: getComputedStyle(panel).transform,
          focusInside: panel.contains(document.activeElement),
          timing: getComputedStyle(panel).transitionTimingFunction.slice(0, 7),
        }
      : null;
  });
  check(
    "drawer opens on the spring, lands at x=0, focus moves inside",
    after !== null && !after.inert && after.focusInside && /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(after.transform) && after.timing === "linear(",
    JSON.stringify(after),
  );
  await shot(page, "verify-mobile-drawer");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => ({
    focused: document.activeElement?.getAttribute("aria-label"),
    inert: document.querySelector("[role=dialog][data-state]")?.hasAttribute("inert"),
  }));
  check("Esc closes it and focus returns to the menu button", back.focused === "Menüyü aç" && back.inert === true, JSON.stringify(back));
  const targets = await page.evaluate(() =>
    [...document.querySelectorAll("[data-shell=mobile] > header button")].map((b) => Math.round(b.getBoundingClientRect().height)),
  );
  check("top-bar touch targets ≥ 44px", targets.every((h) => h >= 44), targets.join(","));
  await context.close();
}

// ── 4b. Narrow web shell: a REAL touch swipe closes the drawer ─────────────
{
  // Real CDP touch input on a touch/mobile context: Chrome claims the moving
  // finger as a pan and fires pointercancel — exactly what broke the old
  // pointer-based swipe. The drawer must still close.
  const { page, context } = await open("mobile", { width: 390, height: 844, touch: true });
  const cdp = await context.newCDPSession(page);
  const pointer = [];
  await page.exposeFunction("__harnessPointer", (kind) => pointer.push(kind));
  await page.evaluate(() => {
    for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
      window.addEventListener(type, (e) => window.__harnessPointer(`${e.type}:${e.pointerType}`), true);
    }
  });
  const point = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  const drag = async (from, to) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
    for (let i = 1; i <= 8; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / 8;
      const y = from.y + ((to.y - from.y) * i) / 8;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500);
  };
  const drawerState = () => page.evaluate(() => document.querySelector("[role=dialog][data-state]")?.getAttribute("data-state"));
  await page.getByRole("button", { name: "Menüyü aç" }).tap();
  await page.waitForTimeout(700);
  const openState = await drawerState();
  pointer.length = 0;
  await drag({ x: 250, y: 420 }, { x: 90, y: 424 });
  const closedState = await drawerState();
  check(
    "touch swipe left closes the nav drawer (even when Chrome cancels the pointer)",
    openState === "open" && closedState === "closed",
    `${openState} → ${closedState}; pointer=${pointer.join(",")}`,
  );
  // A vertical drag over the channel list scrolls; it must NOT close it.
  await page.getByRole("button", { name: "Menüyü aç" }).tap();
  await page.waitForTimeout(700);
  await drag({ x: 200, y: 640 }, { x: 196, y: 400 });
  const stillOpen = await drawerState();
  check("vertical drag over the drawer keeps it open", stillOpen === "open", String(stillOpen));
  await context.close();
}

// ── 4c. Phone: nudges in flow, notices own the bottom band, no collisions ──
{
  const { page, context } = await open("notices", { width: 390, height: 844, query: "&switch=1" });
  await page.waitForTimeout(600);
  const layout = await page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    };
    const nudges = document.querySelector("[data-nudges=bar]");
    const island = document.querySelector("[data-shell=mobile] > .rounded-card");
    const cards = [...document.querySelectorAll("[role=region] [role=status], [role=region] [role=alert]")];
    return {
      nudges: nudges ? { rect: rect(nudges), position: getComputedStyle(nudges).position, kids: nudges.children.length } : null,
      island: island ? rect(island) : null,
      notices: cards.map(rect),
      switchInStack: cards.some((n) => n.textContent?.includes("Hesap değiştirilemedi")),
    };
  });
  const hit = (a, b) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
  const n = layout.notices;
  check(
    "phone: nudges are in flow above the conversation island (cover no message)",
    layout.nudges !== null &&
      layout.nudges.position === "static" &&
      layout.nudges.kids > 0 &&
      // One line of pills (≤ 52px), not a two-row stack.
      layout.nudges.rect.bottom - layout.nudges.rect.top <= 52 &&
      layout.island !== null &&
      layout.nudges.rect.bottom <= layout.island.top,
    JSON.stringify({ nudges: layout.nudges, island: layout.island }),
  );
  check(
    "phone: switch-offline notice joins the stack; no notice overlaps another or a nudge",
    layout.switchInStack &&
      n.length === 4 &&
      !n.some((a, i) => n.some((b, j) => i !== j && hit(a, b))) &&
      !n.some((a) => layout.nudges !== null && hit(a, layout.nudges.rect)),
    JSON.stringify({ n, nudges: layout.nudges?.rect }),
  );
  await shot(page, "verify-notices-phone");
  await context.close();
}


// ── 5. Sign-in: field-level validation, mode switch reveal ─────────────────
{
  const { page, context } = await open("auth", { width: 1280, height: 800 });
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await page.waitForTimeout(250);
  const invalid = await page.evaluate(() => {
    const input = document.querySelector("input[autocomplete='username']");
    const errorId = input?.getAttribute("aria-errormessage");
    return {
      invalid: input?.getAttribute("aria-invalid"),
      bg: input ? getComputedStyle(input).backgroundColor : null,
      message: errorId ? document.getElementById(errorId)?.textContent : null,
    };
  });
  // bg-danger/12 is a color-mix (Chrome serialises it as oklab); assert the
  // 12% wash rather than one colour syntax — the rest tone is opaque #171717.
  check(
    "bad username: field marked invalid, danger wash, message under the field",
    invalid.invalid === "true" && /\/ 0\.12\)/.test(invalid.bg ?? "") && Boolean(invalid.message),
    JSON.stringify(invalid),
  );
  await page.getByRole("button", { name: "Hesap aç" }).click();
  await page.waitForTimeout(80);
  const midReveal = await page.evaluate(() => document.querySelector("input[type=date]") !== null);
  const settled = await animationsSettle(page);
  await page.waitForTimeout(350);
  const revealed = await page.evaluate(() => {
    const date = document.querySelector("input[type=date]");
    const box = date?.closest(".overflow-hidden");
    return { date: date !== null, height: box ? getComputedStyle(box).height : null };
  });
  check("register mode reveals display name + birthdate (animated, settles)", midReveal && revealed.date && revealed.height !== "0px" && settled.unfinished === 0, `${JSON.stringify(revealed)} ${JSON.stringify(settled)}`);
  await shot(page, "verify-auth-register");
  await context.close();
}
{
  // Validation failures are announced and focused (screen-reader path).
  const { page, context } = await open("auth", { width: 1280, height: 800 });
  await page.locator("input[autocomplete='username']").fill("ali");
  await page.locator("input[autocomplete='username']").press("Enter");
  await page.waitForTimeout(150);
  const pw = await page.evaluate(() => {
    const el = document.activeElement;
    const errorId = el?.getAttribute("aria-errormessage");
    const line = errorId ? document.getElementById(errorId) : null;
    return {
      focused: el?.getAttribute("autocomplete"),
      invalid: el?.getAttribute("aria-invalid"),
      describedBy: Boolean(errorId) && (el?.getAttribute("aria-describedby") ?? "").includes(errorId),
      role: line?.getAttribute("role") ?? null,
      text: line?.textContent ?? null,
    };
  });
  check(
    "empty password on Enter: focus moves to the password; its error is role=alert + the description",
    pw.focused === "current-password" && pw.invalid === "true" && pw.describedBy && pw.role === "alert" && pw.text === "Parolanı gir.",
    JSON.stringify(pw),
  );
  await page.locator("input[autocomplete='username']").fill("");
  await page.locator("input[autocomplete='current-password']").fill("dem-123456");
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await page.waitForTimeout(150);
  const user = await page.evaluate(() => ({
    focused: document.activeElement?.getAttribute("autocomplete"),
    invalid: document.activeElement?.getAttribute("aria-invalid"),
  }));
  check("bad username on submit: focus lands on the username field", user.focused === "username" && user.invalid === "true", JSON.stringify(user));
  await context.close();
}
for (const scene of ["auth", "auth-notice", "auth-reauth"]) {
  // Sen'li hitap on every sign-in surface (brand-system §4): no "siz", no
  // "Lütfen", and one term for the secret (parola, never şifre).
  const { page, context } = await open(scene, { width: 1280, height: 800 });
  const copy = await page.evaluate(() => document.body.innerText);
  const siz = copy.match(/Lütfen|unuz|ünüz|ınız|iniz|yapın|deneyin|girin|şifre/g);
  check(`copy voice (${scene}): sen'li, no 'Lütfen'/'siz', one term (parola)`, siz === null, String(siz));
  if (scene === "auth-notice") {
    check("session-expired band reads in sen", copy.includes("Oturumunun süresi doldu. Tekrar giriş yap."), copy.slice(0, 200));
  }
  await context.close();
}


// ── 6. Notices: stack, hover pauses the clock, close works ─────────────────
{
  const { page, context } = await open("notices");
  await page.waitForTimeout(400);
  const count = await page.evaluate(() => document.querySelectorAll("[role=region] [role=status], [role=region] [role=alert]").length);
  check("root notices stack instead of overlapping", count === 3, `notices=${count}`);
  const rects = await page.evaluate(() =>
    [...document.querySelectorAll("[role=region] [role=status], [role=region] [role=alert]")].map((n) => {
      const r = n.getBoundingClientRect();
      return [Math.round(r.top), Math.round(r.bottom)];
    }),
  );
  const overlap = rects.some(([t1, b1], i) => rects.some(([t2, b2], j) => i !== j && t1 < b2 && t2 < b1));
  check("no two notices overlap", !overlap, JSON.stringify(rects));
  const glass = await style(page, "[role=region] [role=alert]", ["backdrop-filter", "border-top-left-radius", "box-shadow"]);
  check("notice card: strong glass, radius 16, inset pill line", glass?.["backdrop-filter"] === "blur(10px)" && glass?.["border-top-left-radius"] === "16px" && /inset/.test(glass?.["box-shadow"] ?? ""), JSON.stringify(glass));
  // ✕ on the short-lived image notice (2.4s) while it is still up.
  const imageNotice = page.locator("[role=region] [role=status]", { hasText: "Görsel kaydedildi" });
  await imageNotice.getByRole("button", { name: "Kapat" }).click();
  await page.waitForTimeout(400);
  check("✕ dismisses with its exit animation", (await imageNotice.count()) === 0);
  // The blocked-send notice lives 6s from its arrival (~0.6s in). Hold the
  // pointer on it well past that: it must survive; release it and it must go.
  // (A real pointer move onto the card's centre; Playwright's locator.hover()
  // runs its own actionability sequence, which was observed landing on the
  // neighbouring card right after a sibling's exit.)
  const blocked = page.locator("[role=region] [role=alert]");
  await animationsSettle(page);
  const bbox = await blocked.boundingBox();
  await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
  const hovering = await blocked.evaluate((el) => el.matches(":hover"));
  await page.waitForTimeout(6500);
  check("hovering a notice pauses its timer", hovering && (await blocked.count()) === 1, `hovering=${hovering}`);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(6500);
  check("leaving resumes it — it dismisses itself", (await blocked.count()) === 0);
  await context.close();
}

// ── 7. Every scene renders with a clean console (TR + EN) ──────────────────
for (const scene of [
  "home", "loading", "empty", "fail", "home-pending", "home-fail", "boot", "boot-slow", "boot-fail", "boot-update", "crash",
  "auth-add", "auth-reauth", "auth-notice", "birthdate", "switching", "switch-offline", "update",
]) {
  const { page, context } = await open(scene, { width: 1280, height: 800 });
  await shot(page, `scene-${scene}`);
  await context.close();
}
for (const scene of ["shell", "auth"]) {
  const { page, context } = await open(scene, { width: 1280, height: 800, lang: "en" });
  const englishOk = await page.evaluate(
    (s) => (s === "auth" ? document.body.textContent?.includes("Welcome back") : document.body.textContent?.includes("Text channels")),
    scene,
  );
  check(`EN catalog renders (${scene})`, Boolean(englishOk));
  await context.close();
}

// The ONE tolerated line: framer-motion's dev-only notice, printed because the
// reduced-motion check above emulates `prefers-reduced-motion: reduce` on purpose
// (warnOnce — stripped from production builds). Listed here so it is a decision.
const KNOWN = [/^\[shell\] warning: You have Reduced Motion enabled on your device/];
const unexpected = consoleProblems.filter((line) => !KNOWN.some((re) => re.test(line)));
check(
  "console: 0 errors / warnings across every scene",
  unexpected.length === 0,
  `${unexpected.join(" || ").slice(0, 2000)} (tolerated: ${consoleProblems.length - unexpected.length} framer reduced-motion dev notice)`,
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
