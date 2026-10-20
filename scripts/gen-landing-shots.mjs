#!/usr/bin/env node
/* global console, process, document, getComputedStyle, HTMLElement */
/**
 * Landing phone screenshots — rendered from the REAL product, never drawn.
 *
 * Every image the landing shows inside its phone frame is a headless
 * screenshot of a shipping Demli component, mounted by the dev-only harness
 * pages in apps/web (harness-shell / harness-chat / harness-voice). Those
 * harnesses render the desktop renderer's real components with the real
 * stylesheet and only fake the network, so the pixels here are the pixels a
 * user sees. The phone bezel is NOT in the image: the landing draws it in CSS
 * (apps/landing/src/components/molecules/PhoneMockup.tsx).
 *
 * Output (committed, so a build never needs Chrome):
 *   apps/landing/public/images/shots/<shot>-<tr|en>.webp   780×1688 (390×844 @2x)
 *
 *   hero    #genel in the chat view — reactions, markdown, a pinned
 *           announcement, a link preview (harness-chat)
 *   voice   the mobile channel drawer while connected to a voice room:
 *           speaking ring, muted member, the voice panel (harness-shell)
 *   screen  the share sheet — 480p…2K and 15/30/60 fps (harness-voice)
 *   table   an invite card in chat — joining is by invitation (harness-chat)
 *
 * Run (system Chrome, headless; playwright-core is deliberately not a repo
 * dependency, the npx line fetches it for the run):
 *   npx -y -p playwright-core@1.48.2 node scripts/gen-landing-shots.mjs
 * or, with a local copy:  PLAYWRIGHT_CORE=<path to playwright-core> node scripts/gen-landing-shots.mjs
 *
 * The script starts its own Vite dev server for apps/web on a free port and
 * stops it afterwards. Exit 1 if any page logs a console error.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createServer as createNetServer } from "node:net";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps/web");
const OUT = join(ROOT, "apps/landing/public/images/shots");
const LOCALES = ["tr", "en"];
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2;
const WEBP = { quality: 80, effort: 6, smartSubsample: true };

const catalog = (lng) =>
  JSON.parse(readFileSync(join(ROOT, `packages/i18n/src/locales/${lng}/desktop.json`), "utf8"));

/**
 * Scroll the (virtualised) chat list so the row containing `text` sits
 * `offset` px below the list top. Rows outside the window are not in the DOM,
 * so the list is walked upwards from the bottom until the text mounts.
 */
async function scrollChatTo(page, text, offset) {
  for (let step = 0; step < 40; step += 1) {
    const done = await page.evaluate(
      ({ text, offset }) => {
        const scrollers = [...document.querySelectorAll("*")].filter(
          (el) => el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY),
        );
        const list = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        if (!list) throw new Error("no scroll container");
        const hit = [...list.querySelectorAll("*")].find(
          (el) => el.childElementCount === 0 && el.textContent?.includes(text),
        );
        if (!hit) {
          list.scrollTop -= 500;
          return false;
        }
        list.scrollTop += hit.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
        return true;
      },
      { text, offset },
    );
    await page.waitForTimeout(250);
    if (done) return;
  }
  throw new Error(`text never mounted: ${text}`);
}

/** Hide the transient "jump to present" pill a scrolled-up list shows. */
async function hideJumpPill(page, lng) {
  const label = catalog(lng).chat.jumpToPresent;
  await page.evaluate((label) => {
    for (const b of document.querySelectorAll("button")) {
      if (b.textContent?.trim() === label) b.style.visibility = "hidden";
    }
  }, label);
}

const SHOTS = {
  async hero(page, lng) {
    await page.goto(`/harness-chat.html?lang=${lng}`);
    await settle(page);
    await page.addStyleTag({ content: "nav{display:none!important}" });
    // Twice: link previews and images resize their rows after the first pass.
    await scrollChatTo(page, "@everyone", 44);
    await page.waitForTimeout(900);
    await scrollChatTo(page, "@everyone", 44);
    await page.waitForTimeout(600);
    await hideJumpPill(page, lng);
  },
  async voice(page, lng) {
    await page.goto(`/harness-shell.html?scene=mobile&lang=${lng}`);
    await settle(page);
    await page.locator("button").first().click();
    await page.waitForTimeout(900);
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.waitForTimeout(600);
  },
  async screen(page, lng) {
    await page.goto(`/harness-voice.html?lng=${lng}`);
    await settle(page);
    await page.locator("[data-testid=open-picker]").click();
    await page.waitForTimeout(900);
    const dialog = page.getByTestId("source-picker");
    // Share the entire screen at the top of the quality ladder.
    await dialog.getByText(catalog(lng).sourcePicker.webScreen, { exact: true }).click();
    await dialog.getByRole("radio", { name: "2K" }).click();
    await dialog.getByRole("radio", { name: /^60/ }).click();
    // Bring the quality ladder into the top half of the sheet: the landing's
    // phone frame shows the upper part of the screen and fades the rest.
    await dialog.evaluate((root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
    await page.mouse.move(VIEWPORT.width - 2, 2);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.waitForTimeout(600);
  },
  async table(page, lng) {
    await page.goto(`/harness-chat.html?lang=${lng}`);
    await settle(page);
    await page.addStyleTag({ content: "nav{display:none!important}" });
    await scrollChatTo(page, "CayEvi24", 104);
    await page.waitForTimeout(900);
    await scrollChatTo(page, "CayEvi24", 104);
    await page.waitForTimeout(600);
    await hideJumpPill(page, lng);
  },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function settle(page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
}

async function main() {
  const only = process.argv.slice(2);
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  const server = await createServer({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    logLevel: "warn",
    server: { port, host: "127.0.0.1", strictPort: true },
  });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error("vite did not report a URL");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const problems = [];
  try {
    for (const [name, stage] of Object.entries(SHOTS)) {
      if (only.length && !only.includes(name)) continue;
      for (const lng of LOCALES) {
        const context = await browser.newContext({
          baseURL: base,
          viewport: VIEWPORT,
          deviceScaleFactor: SCALE,
          reducedMotion: "reduce",
          colorScheme: "dark",
        });
        context.setDefaultNavigationTimeout(180_000);
        const page = await context.newPage();
        page.on("console", (m) => {
          if (m.type() === "error") problems.push(`${name}-${lng}: ${m.text()}`);
        });
        page.on("pageerror", (e) => problems.push(`${name}-${lng}: ${e.message}`));
        await stage(page, lng);
        const png = await page.screenshot({ type: "png" });
        const file = join(OUT, `${name}-${lng}.webp`);
        const webp = await sharp(png).webp(WEBP).toBuffer();
        writeFileSync(file, webp);
        console.log(`${name}-${lng}.webp  ${(webp.length / 1024).toFixed(0)} KB`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (problems.length) {
    console.error(`FAIL — ${problems.length} console error(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

await main();
