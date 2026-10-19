/**
 * Headless verification of the chat harness (DEV ONLY, not part of any build).
 *
 *   1. pnpm --filter @demli/web exec vite --port 5437 --strictPort
 *   2. PLAYWRIGHT_CORE=<path to a playwright-core install> \
 *        node apps/web/src/harness/chat/verify-chat.mjs [baseUrl] [shotDir]
 *
 * Drives system Chrome (channel "chrome") through every scene of
 * harness-chat.html and asserts, with MEASURED values (computed styles, DOM
 * state, focus), what the M16 messaging redesign promises: token surfaces and
 * fonts, tone-only hover that never changes a row's height, the toolbar fade,
 * open/close animations finishing, keyboard paths (↑-to-edit, mention picker,
 * search cursor, lightbox keys), every loading/empty/error state, reduced
 * motion, zero console errors/warnings and zero unmodelled API calls.
 *
 * playwright-core is deliberately NOT a repo dependency (no lockfile churn for a
 * dev check) — point PLAYWRIGHT_CORE at any install. Exit code 1 on any failure.
 */
/* global console, process, document, window, getComputedStyle */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

const BASE = process.argv[2] ?? "http://127.0.0.1:5437/harness-chat.html";
const SHOTS = process.argv[3] ?? "tmp/m16-shots/chat";
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const TOKENS = {
  app: "rgb(13, 13, 13)",
  surface: "rgb(23, 23, 23)",
  raised: "rgb(38, 38, 38)",
  accent: "rgb(255, 132, 100)",
  accentHover: "rgb(255, 164, 140)",
  accentSurface: "rgba(255, 132, 100, 0.12)",
  transparent: "rgba(0, 0, 0, 0)",
};

const browser = await chromium.launch({ channel: "chrome", headless: true });

/** Open a scene with console + page-error capture. */
async function open(query, { reducedMotion = "no-preference", width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}${query}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__chatHarnessReady === true);
  await page.waitForTimeout(900);
  return { context, page, logs };
}

/**
 * framer-motion's DEVELOPMENT build prints exactly this once when the OS asks
 * for reduced motion and MotionConfig reducedMotion="user" honours it. It is the
 * library confirming the behaviour under test, not a defect, and production
 * builds strip it — so it is the ONE message tolerated, and only in the
 * reduced-motion run.
 */
const FRAMER_REDUCED_MOTION_NOTICE =
  "[warning] You have Reduced Motion enabled on your device. Animations may not appear as expected.";

async function close({ context, page, logs }, label, { reducedMotion = false } = {}) {
  const unhandled = await page.evaluate(() => window.__chatHarness?.unhandled ?? []);
  const relevant = reducedMotion ? logs.filter((l) => !l.startsWith(FRAMER_REDUCED_MOTION_NOTICE)) : logs;
  check(`${label}: no console errors/warnings`, relevant.length === 0, relevant.slice(0, 5).join(" | "));
  check(`${label}: no unmodelled API calls`, unhandled.length === 0, unhandled.join(", "));
  await context.close();
}

/* ── 1. #genel — the full fixture ────────────────────────────────────────── */
{
  const s = await open("?scene=channel&ch=genel");
  const { page } = s;
  await page.screenshot({ path: `${SHOTS}/01-channel-bottom.png` });

  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    title: getComputedStyle(document.querySelector("header h1")).fontFamily,
    name: getComputedStyle(document.querySelector("[data-message-id] .font-semibold")).fontFamily,
  }));
  check("body font is Inter", fonts.body.startsWith('"Inter"') || fonts.body.startsWith("Inter"), fonts.body);
  check("channel title font is Onest (display)", fonts.title.includes("Onest"), fonts.title);
  check("author name uses Inter", fonts.name.includes("Inter"), fonts.name);

  const column = await page.evaluate(() => getComputedStyle(document.querySelector("header").parentElement).backgroundColor);
  check("conversation column = app token #0d0d0d", column === TOKENS.app, column);

  // Unread line + its coral chip.
  const unread = await page.evaluate(() => {
    const sep = [...document.querySelectorAll('[role="separator"]')].find((el) => el.querySelector(".uppercase"));
    if (!sep) return null;
    const chip = sep.querySelector(".uppercase");
    return { text: chip.textContent, bg: getComputedStyle(chip).backgroundColor, ink: getComputedStyle(chip).color };
  });
  check("unread divider renders with the 'Yeni' chip", unread?.text === "Yeni", JSON.stringify(unread));
  check("unread chip is solid coral with dark ink", unread?.bg === TOKENS.accent && unread?.ink === "rgb(23, 23, 23)", JSON.stringify(unread));

  const dividers = await page.evaluate(() =>
    [...document.querySelectorAll('[role="separator"]')].map((el) => el.getAttribute("aria-label")),
  );
  check("a 'Bugün' date divider is in the window", dividers.includes("Bugün"), dividers.join(" / "));

  // Mention chip of the viewer.
  const mention = await page.evaluate(() => {
    const el = document.querySelector('[data-mention="user"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: el.textContent, bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius };
  });
  check("mention chip = coral wash + light-coral label, radius 6", mention && mention.color === TOKENS.accentHover && mention.radius === "6px", JSON.stringify(mention));
  const mentionRow = await page.evaluate(() => {
    const row = document.querySelector('[data-mention="user"]')?.closest("[data-message-id]");
    return row ? getComputedStyle(row).borderLeftColor : null;
  });
  check("a message that mentions you carries the coral trace", mentionRow === TOKENS.accent, mentionRow);

  // Hover: tone only, toolbar fades in, the row's height never changes.
  const rowSel = '[data-message-id="m17"]';
  const before = await page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const bar = row.querySelector("[data-open], .invisible");
    return { h: row.getBoundingClientRect().height, bg: getComputedStyle(row).backgroundColor, barOpacity: bar ? getComputedStyle(bar).opacity : null, barVis: bar ? getComputedStyle(bar).visibility : null, transition: getComputedStyle(row).transitionDuration };
  }, rowSel);
  await page.hover(`${rowSel} p`);
  await page.waitForTimeout(400);
  const after = await page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const bar = [...row.children].find((c) => c.className.includes("absolute -top-4"));
    const bcs = getComputedStyle(bar);
    return { h: row.getBoundingClientRect().height, bg: getComputedStyle(row).backgroundColor, barOpacity: bcs.opacity, barVis: bcs.visibility, barBg: bcs.backgroundColor, barRadius: bcs.borderTopLeftRadius, barBorder: bcs.borderTopWidth };
  }, rowSel);
  check("row at rest is transparent on the app tone", before.bg === TOKENS.transparent, before.bg);
  check("row hover = surface tone #171717", after.bg === TOKENS.surface, after.bg);
  check("row hover transition is the 200ms hover step", before.transition.includes("0.2s"), before.transition);
  check("hover never changes the row height (virtualizer contract)", Math.abs(after.h - before.h) < 0.5, `${before.h} → ${after.h}`);
  check("toolbar hidden at rest (opacity 0, invisible)", before.barOpacity === "0" && before.barVis === "hidden", `${before.barOpacity}/${before.barVis}`);
  check("toolbar faded in on hover", after.barOpacity === "1" && after.barVis === "visible", `${after.barOpacity}/${after.barVis}`);
  check("toolbar = raised tone, radius 12, no border", after.barBg === TOKENS.raised && after.barRadius === "12px" && after.barBorder === "0px", JSON.stringify(after));
  // The invite card inside the hovered row must stay distinguishable from it.
  const cardOnHover = await page.evaluate((sel) => {
    const card = document.querySelector(sel).querySelector('[class*="min-h-[88px]"]');
    return card ? getComputedStyle(card).backgroundColor : null;
  }, rowSel);
  check("an embed card keeps its own tone on a hovered row", cardOnHover === "rgba(255, 255, 255, 0.06)" && cardOnHover !== after.bg, String(cardOnHover));
  await page.screenshot({ path: `${SHOTS}/02-row-hover-toolbar.png` });

  // Toolbar button: hover wash, focus-visible ring by keyboard.
  const moreBtn = page.locator(`${rowSel} button[aria-label="Daha fazla"]`);
  await moreBtn.hover();
  await page.waitForTimeout(300);
  const moreHover = await moreBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
  check("toolbar button hover = white wash", moreHover === "rgba(255, 255, 255, 0.06)", moreHover);
  await moreBtn.click();
  await page.waitForSelector('[role="menu"]');
  const menu = await page.evaluate(() => {
    const m = document.querySelector('[role="menu"]');
    const cs = getComputedStyle(m);
    return { anim: cs.animationName, radius: cs.borderTopLeftRadius, items: [...m.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent) };
  });
  check("more menu opens with the pop-in animation", menu.anim.includes("pop-in"), menu.anim);
  // m17 is someone else's message: reply/copy/pin, but never edit or delete.
  check(
    "another member's message menu offers reply/copy/pin, not edit/delete",
    menu.items.some((t) => t.includes("Yanıtla")) &&
      menu.items.some((t) => t.includes("Metni kopyala")) &&
      !menu.items.some((t) => t.includes("Düzenle") || t.includes("Sil")),
    menu.items.join(","),
  );
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/03-more-menu.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("menu closes and unmounts after its exit animation", (await page.locator('[role="menu"]').count()) === 0);

  // Reactions: pill shape, mine = coral wash, toggling changes the count.
  const reactions = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("button[aria-pressed]")].filter((b) => b.className.includes("rounded-pill"));
    return chips.map((b) => ({ pressed: b.getAttribute("aria-pressed"), bg: getComputedStyle(b).backgroundColor, radius: getComputedStyle(b).borderTopLeftRadius, count: b.textContent }));
  });
  const mine = reactions.find((r) => r.pressed === "true");
  const theirs = reactions.find((r) => r.pressed === "false");
  check("reaction pills are fully rounded", reactions.length > 0 && reactions.every((r) => r.radius === "50px"), JSON.stringify(reactions[0]));
  check("my reaction = accent-soft wash", mine?.bg === TOKENS.accentSurface, JSON.stringify(mine));
  check("others' reaction = white wash (stays visible on a hovered row)", theirs?.bg === "rgba(255, 255, 255, 0.06)", JSON.stringify(theirs));

  // ↑ in the empty composer edits my last message; Esc hands focus back.
  const composer = page.locator('textarea[aria-label="#genel kanalına mesaj yaz"]');
  const frameAtRest = await composer.evaluate((el) => getComputedStyle(el.closest(".rounded-xl")).backgroundColor);
  check("composer at rest = surface tone, borderless", frameAtRest === TOKENS.surface, frameAtRest);
  await composer.click();
  await page.waitForTimeout(350);
  const frame = await composer.evaluate((el) => {
    const f = el.closest(".rounded-xl");
    const cs = getComputedStyle(f);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, caret: getComputedStyle(el).caretColor, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth };
  });
  check("composer focused (pointer still on it) = raised tone + coral inner trace", frame.bg === TOKENS.raised && frame.shadow.includes("255, 132, 100, 0.24") && frame.border === "0px", JSON.stringify(frame));
  check("composer radius 16", frame.radius === "16px", frame.radius);
  check("composer caret is coral", frame.caret === TOKENS.accent, frame.caret);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(400);
  const editor = page.locator('textarea[aria-label="Mesaj düzenleniyor"]');
  check("↑ in an empty composer opens the editor on my last message", (await editor.count()) === 1 && (await editor.inputValue()).startsWith("Bir de çay"));
  check("the editor has keyboard focus", await editor.evaluate((el) => document.activeElement === el));
  await page.screenshot({ path: `${SHOTS}/04-edit-mode.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc closes the editor and returns focus to the composer", (await editor.count()) === 0 && (await composer.evaluate((el) => document.activeElement === el)));

  // Mention autocomplete: listbox, active descendant, keyboard.
  await composer.type("@de");
  await page.waitForSelector('[role="listbox"]');
  const mentionBox = await page.evaluate(() => {
    const ta = document.querySelector("textarea[aria-autocomplete]");
    const box = document.querySelector('[role="listbox"]').parentElement;
    const cs = getComputedStyle(box);
    return {
      active: ta.getAttribute("aria-activedescendant"),
      options: [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent),
      bg: cs.backgroundColor,
      blur: cs.backdropFilter,
      border: cs.borderTopWidth,
    };
  });
  check("mention picker lists Deniz with an active descendant", mentionBox.options.some((o) => o.includes("Deniz")) && Boolean(mentionBox.active), JSON.stringify(mentionBox));
  check("mention picker = strong glass + blur, borderless", mentionBox.bg === "rgba(23, 23, 23, 0.92)" && mentionBox.blur.includes("blur") && mentionBox.border === "0px", JSON.stringify(mentionBox));
  await page.screenshot({ path: `${SHOTS}/05-mention-picker.png` });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("Enter picks the mention into the composer", (await composer.inputValue()).startsWith("@Deniz"), await composer.inputValue());
  await composer.fill("");

  // Pins board: skeleton → rows, Esc closes.
  await page.click('button[aria-label="Sabitlenmiş mesajlar"]');
  const pinSkeleton = await page.locator('[role="dialog"] [role="status"]').count();
  await page.waitForTimeout(700);
  const pins = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return { rows: d.querySelectorAll('button[aria-label="Mesaja git"]').length, bg: getComputedStyle(d).backgroundColor, anim: getComputedStyle(d).animationName };
  });
  check("pins board shows a skeleton while loading", pinSkeleton > 0);
  check("pins board lists both pins on the surface tone", pins.rows === 2 && pins.bg === TOKENS.surface, JSON.stringify(pins));
  await page.screenshot({ path: `${SHOTS}/06-pins.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);

  // Search: highlight, keyboard cursor, jump flash, error + empty states.
  await page.click('button[aria-label="Ara"]');
  const search = page.locator('aside input[aria-label="Ara"]');
  await search.fill("çay");
  await page.waitForTimeout(350);
  const searchSkeleton = await page.locator('aside [role="status"]').count();
  await page.waitForTimeout(700);
  const marks = await page.evaluate(() => [...document.querySelectorAll("aside mark")].map((m) => ({ t: m.textContent, bg: getComputedStyle(m).backgroundColor, c: getComputedStyle(m).color })));
  check("search shows a results skeleton while searching", searchSkeleton > 0);
  check("search highlights the hit in coral", marks.length > 0 && marks[0].bg === TOKENS.accentSurface && marks[0].c === TOKENS.accentHover, JSON.stringify(marks[0]));
  await search.press("ArrowDown");
  await page.waitForTimeout(250);
  const activeRow = await page.evaluate(() => {
    const r = document.querySelector("aside button[data-active]");
    return r ? getComputedStyle(r).backgroundColor : null;
  });
  check("↓ moves the search cursor (raised tone)", activeRow === TOKENS.raised, activeRow);
  await page.screenshot({ path: `${SHOTS}/07-search-results.png` });
  await search.press("Enter");
  await page.waitForTimeout(500);
  const flashed = await page.evaluate(() => [...document.querySelectorAll("[data-message-id]")].some((r) => getComputedStyle(r).backgroundColor === "rgba(255, 132, 100, 0.12)"));
  check("Enter jumps to the message and flashes it", flashed);
  await search.fill("hata");
  // The query retries a 500 with backoff before giving up — the skeleton stays
  // up meanwhile, and only then does the error copy appear.
  const searchError = await page
    .waitForSelector('aside [role="alert"] button', { timeout: 15000 })
    .then(() => true, () => false);
  check("a failed search shows the error copy + retry", searchError);
  await search.fill("zzzzz");
  await page.waitForTimeout(1300);
  check("an empty search says so", (await page.locator("aside").innerText()).includes("için mesaj bulunamadı"));
  await page.screenshot({ path: `${SHOTS}/08-search-empty.png` });
  await search.press("Escape");
  await page.waitForTimeout(300);

  // Load older: scroll to the top → skeleton row → older page.
  await page.evaluate(() => {
    const list = document.querySelector('[aria-label="genel mesajları"]');
    list.scrollTop = 0;
  });
  await page.waitForTimeout(250);
  const olderSkeleton = await page.locator('[aria-label="Daha eski mesajlar yükleniyor…"]').count();
  check("scrolling to the top shows the older-page skeleton", olderSkeleton === 1);
  await page.waitForTimeout(1600);
  const requests = await page.evaluate(() => window.__chatHarness.requests);
  check("an older page was fetched with a cursor", requests.filter((r) => r.startsWith("GET /channels/c-genel/messages")).length >= 2);

  // The 3-up grid + lightbox.
  await page.evaluate(() => {
    const list = document.querySelector('[aria-label="genel mesajları"]');
    const row = document.querySelector('[data-message-id="m08"]');
    if (row) row.scrollIntoView({ block: "center" });
    else list.scrollTop = 0;
  });
  await page.waitForTimeout(900);
  const grid = await page.evaluate(() => {
    const row = document.querySelector('[data-message-id="m08"]');
    if (!row) return null;
    const tiles = [...row.querySelectorAll('button[aria-label="Resmi aç"]')];
    return tiles.map((t) => {
      const r = t.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(t.parentElement).borderTopLeftRadius };
    });
  });
  check("3 images render as an even grid of square cells", grid?.length === 3 && grid.every((t) => t.w === t.h && t.w === grid[0].w), JSON.stringify(grid));
  await page.screenshot({ path: `${SHOTS}/09-image-grid.png` });
  await page.locator('[data-message-id="m08"] button[aria-label="Resmi aç"]').first().click();
  await page.waitForSelector('[role="dialog"] img');
  // Sample the open animation WHILE it runs, then again once it should be done:
  // "an animation was running and then it finished", not merely "none found".
  const opening = await page.evaluate(() =>
    document
      .querySelector('[role="dialog"]')
      .getAnimations({ subtree: true })
      .map((a) => `${a.animationName}:${a.playState}`),
  );
  await page.waitForTimeout(600);
  const box = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return {
      counter: d.querySelector("[aria-live]")?.textContent,
      running: d.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).length,
    };
  });
  check("lightbox opens with fade + pop animations running", opening.some((a) => a.startsWith("fade-in:running")) && opening.some((a) => a.startsWith("pop-in:running")), opening.join(","));
  check("lightbox opens on the clicked image with a counter", box.counter === "1 / 3", JSON.stringify(box));
  check("lightbox open animations finished (no finite animation still running)", box.running === 0, JSON.stringify(box));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  check("→ pages to the next image", (await page.locator('[role="dialog"] [aria-live]').first().textContent()) === "2 / 3");
  await page.keyboard.press("+");
  await page.waitForTimeout(400);
  const zoom = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const stage = d.querySelector(".will-change-transform");
    return { transform: stage.style.transform, label: [...d.querySelectorAll("span[aria-live]")].map((s) => s.textContent) };
  });
  check("+ zooms to 150%", zoom.transform.includes("scale(1.5)") && zoom.label.includes("%150"), JSON.stringify(zoom));
  await page.screenshot({ path: `${SHOTS}/10-lightbox-zoomed.png` });
  // Drag pans a zoomed image.
  const stageBox = await page.locator('[role="dialog"] .cursor-grab').boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 80, stageBox.y + stageBox.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const panned = await page.evaluate(() => document.querySelector('[role="dialog"] .will-change-transform').style.transform);
  check("dragging pans the zoomed image", panned.includes("80px") || /translate3d\((?!0px, 0px)/.test(panned), panned);
  await page.keyboard.press("0");
  await page.waitForTimeout(350);
  check("0 fits the image again", (await page.evaluate(() => document.querySelector('[role="dialog"] .will-change-transform').style.transform)).includes("scale(1)"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("Esc closes the lightbox after its fade", (await page.locator('[role="dialog"]').count()) === 0);

  // Broken attachment = honest error with retry.
  await page.evaluate(() => document.querySelector('[data-message-id="m15"]')?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(800);
  check("a deleted attachment shows the error tile with retry", (await page.locator('[data-message-id="m15"] [role="alert"] button').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/11-history-attachments.png` });

  await close(s, "channel");
}

/* ── 2. Every other channel state ─────────────────────────────────────────── */
{
  const s = await open("?scene=channel&ch=loading");
  check("loading: skeleton with role=status", (await s.page.locator('[role="status"][aria-label="Mesajlar yükleniyor…"]').count()) === 1);
  await s.page.screenshot({ path: `${SHOTS}/12-loading.png` });
  await close(s, "loading");
}
{
  const s = await open("?scene=channel&ch=error");
  await s.page.waitForTimeout(600);
  const alert = await s.page.locator('[role="alert"]').innerText();
  check("error: title + detail + retry", alert.includes("Mesajlar yüklenemedi") && (await s.page.locator('[role="alert"] button').count()) === 1, alert.replace(/\n/g, " | "));
  await s.page.screenshot({ path: `${SHOTS}/13-error.png` });
  await close(s, "error");
}
{
  const s = await open("?scene=channel&ch=empty");
  const intro = await s.page.locator("h2").first().innerText();
  check("empty: channel intro in the display font", intro.includes("yeni-kanal") && (await s.page.locator("h2").first().evaluate((el) => getComputedStyle(el).fontFamily)).includes("Onest"), intro);
  await s.page.screenshot({ path: `${SHOTS}/14-empty.png` });
  await close(s, "empty");
}
{
  const s = await open("?scene=channel&ch=slow");
  const text = await s.page.locator("main").innerText();
  check("slow mode: live countdown pill", /Yavaş mod — \d+s sonra/.test(text), "");
  check("slow mode: interval note under the composer", text.includes("Yavaş mod açık"));
  check("typing line names both typers with dots", text.includes("Elif ve Mert yazıyor"));
  const anchoring = await s.page.evaluate(() => {
    const list = document.querySelector('[aria-label="duyurular mesajları"]').getBoundingClientRect();
    const row = document.querySelector('[data-message-id="s1"]').getBoundingClientRect();
    return { gap: Math.round(list.bottom - row.bottom), listH: Math.round(list.height) };
  });
  check("a short thread sits on the composer, not under the header", anchoring.gap >= 0 && anchoring.gap <= 24, JSON.stringify(anchoring));
  await s.page.screenshot({ path: `${SHOTS}/15-slowmode-typing.png` });
  await close(s, "slow");
}
{
  const s = await open("?scene=channel&ch=nsfw");
  const card = await s.page.locator("section[aria-labelledby]").evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderTopLeftRadius, text: el.textContent }));
  check("nsfw (adult): confirm card on the surface tone, radius 24", card.bg === TOKENS.surface && card.radius === "24px" && card.text.includes("Devam et"), JSON.stringify(card));
  await s.page.screenshot({ path: `${SHOTS}/16-nsfw-confirm.png` });
  await s.page.click('button:has-text("Devam et")');
  await s.page.waitForTimeout(600);
  check("nsfw: continuing opens the channel", (await s.page.locator("header h1").count()) === 1);
  await close(s, "nsfw");
}
{
  const s = await open("?scene=channel&ch=nsfw&age=minor");
  check("nsfw (minor): final refusal with no action", (await s.page.locator("section[aria-labelledby] button").count()) === 0);
  await close(s, "nsfw-minor");
}

/* ── 3. Blocked DM composer ───────────────────────────────────────────────── */
{
  const s = await open("?scene=blocked");
  await s.page.waitForTimeout(500);
  const status = await s.page.locator('main [role="status"]').last().innerText();
  check("blocked DM: the composer says who you blocked and offers unblock", status.includes("Can adlı kişiyi engelledin"), status);
  check("blocked DM: no textarea to type into", (await s.page.locator("main textarea").count()) === 0);
  await s.page.screenshot({ path: `${SHOTS}/17-blocked.png` });
  await s.page.click('button:has-text("Engeli kaldır")');
  await s.page.waitForTimeout(500);
  check("unblock goes through the ONE confirmation dialog", (await s.page.locator('[role="dialog"]').count()) === 1);
  await s.page.screenshot({ path: `${SHOTS}/18-unblock-confirm.png` });
  await close(s, "blocked");
}

/* ── 4. Composer states ──────────────────────────────────────────────────── */
{
  const s = await open("?scene=composer");
  const { page } = s;
  const bar = await page.locator('[role="progressbar"]').getAttribute("aria-valuenow");
  check("upload progress is a real progressbar at 42%", bar === "42", bar);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[role="group"] > div')].map((c) => getComputedStyle(c).backgroundColor),
  );
  // `bg-danger/12` is a color-mix, so Chrome reports it in oklab — assert the
  // 12% alpha and that it is NOT the neutral wash.
  const wash = "rgba(255, 255, 255, 0.06)";
  check(
    "draft cards use the wash; failed ones the danger wash",
    cards.filter((c) => c === wash).length === 3 && cards.filter((c) => c !== wash && c.endsWith("/ 0.12)")).length === 2,
    cards.join(" "),
  );
  check("reply banner sits inside the composer", (await page.locator('[data-harness="composer"] button[aria-label="Yanıtı iptal et"]').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/19-composer-states.png` });
  await page.click('button[aria-label="gun-batimi.png dosyasını kaldır"]');
  await page.waitForTimeout(200);
  check("removing a draft removes its card", (await page.locator('button[aria-label="gun-batimi.png dosyasını kaldır"]').count()) === 0);
  await page.click('[data-harness="composer"] button[aria-label="Emoji ekle"]');
  await page.waitForTimeout(1500);
  check("the emoji picker opens (lazy chunk loaded)", (await page.locator("em-emoji-picker").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/20-emoji-picker.png` });
  await close(s, "composer");
}

/* ── 5. English + reduced motion ─────────────────────────────────────────── */
{
  const s = await open("?scene=channel&ch=genel&lang=en");
  const text = await s.page.locator("main").innerText();
  // innerText applies the chip's text-transform, hence "NEW".
  const placeholder = await s.page.locator("textarea[aria-autocomplete]").getAttribute("placeholder");
  check("EN: 'NEW' chip, 'Today' divider, English composer", text.includes("NEW") && text.includes("Today") && placeholder === "Message #genel", `${placeholder}`);
  await s.page.screenshot({ path: `${SHOTS}/21-english.png` });
  await close(s, "english");
}
{
  const s = await open("?scene=channel&ch=genel", { reducedMotion: "reduce" });
  await s.page.hover('[data-message-id="m17"] p');
  const durations = await s.page.evaluate(() => {
    const row = document.querySelector('[data-message-id="m17"]');
    const bar = [...row.children].find((c) => c.className.includes("absolute -top-4"));
    return { row: getComputedStyle(row).transitionDuration, bar: getComputedStyle(bar).transitionDuration };
  });
  check("reduced motion: hover/toolbar transitions are flattened", durations.row.startsWith("1e-05") && durations.bar.startsWith("1e-05"), JSON.stringify(durations));
  await close(s, "reduced-motion", { reducedMotion: true });
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
