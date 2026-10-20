#!/usr/bin/env node
/* global console, process, document, window, getComputedStyle, HTMLElement, HTMLImageElement, performance */
/**
 * README screenshots — rendered from the REAL product, never drawn.
 *
 * Same method as scripts/gen-landing-shots.mjs: the dev-only harness pages in
 * apps/web (harness-shell / -chat / -voice / -settings / -profile) mount the
 * desktop renderer's shipping components with the real stylesheet and only
 * fake the network, so every pixel here is a pixel a user sees. All people,
 * servers and messages are invented fixtures.
 *
 * Output (committed, so the README never needs Chrome):
 *   docs/images/<name>.webp
 *
 *   chat                 four-column shell: server rail, channels, #sohbet, members
 *   voice                the video stage: six people, the speaker's tile lit
 *   screen-share-picker  Electron source picker: a window, "only this app" sound
 *   settings-microphone  Settings → Microphone
 *   avatar-crop          the avatar crop editor
 *   search               message search inside a channel
 *
 * Captured at 1440×900 @2x, then full-window shots are downscaled to 1600 px
 * wide. Single components (dialogs, the stage) are cut out on a transparent
 * background so they sit cleanly on GitHub's light and dark themes.
 *
 * Run (system Chrome, headless; playwright-core is deliberately not a repo
 * dependency, the npx line fetches it for the run):
 *   npx -y -p playwright-core@1.48.2 node scripts/gen-readme-shots.mjs [name...]
 * or, with a local copy:  PLAYWRIGHT_CORE=<path to playwright-core> node scripts/gen-readme-shots.mjs
 *
 * The script starts its own Vite dev server for apps/web on a free port and
 * stops it afterwards. Exit 1 if any page throws or logs a console error.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createNetServer } from "node:net";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps/web");
const OUT = join(ROOT, "docs/images");
const only = process.argv.slice(2);

// vite resolves from apps/web (the root package does not depend on it).
const fromWeb = createRequire(join(WEB, "package.json"));
const VITE_DIR = dirname(fromWeb.resolve("vite/package.json"));
const { createServer } = await import(pathToFileURL(join(VITE_DIR, "dist/node/index.js")).href);
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_CORE ?? "playwright-core",
);

const DESKTOP = { width: 1440, height: 900 };
const SCALE = 2;
const MAX_WIDTH = 1600;
const WEBP = { quality: 82, effort: 6, smartSubsample: true, alphaQuality: 100 };

async function settle(page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
}

/** Park the pointer and drop focus so no hover/focus ring is captured. */
async function rest(page) {
  await page.mouse.move(2, DESKTOP.height - 2);
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  await page.waitForTimeout(500);
}

/**
 * Hide everything except `selector`'s subtree and make the page transparent,
 * so an element screenshot keeps the component's own rounded corners. A
 * full-viewport wrapper (dialog positioner + scrim) is narrowed to the largest
 * painted card inside it, so the scrim is not captured.
 */
async function isolate(page, selector) {
  await page.evaluate((selector) => {
    let target = document.querySelector(selector);
    if (!target) throw new Error(`isolate: ${selector} not found`);
    const vw = window.innerWidth * window.innerHeight;
    const area = (el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    if (area(target) > vw * 0.7) {
      const painted = [...target.querySelectorAll("*")].filter((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        return area(el) < vw * 0.6 && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      });
      painted.sort((a, b) => area(b) - area(a));
      if (painted[0]) target = painted[0];
    }
    target.setAttribute("data-shot-keep", "");
  }, selector);
  await page.addStyleTag({
    content: `
      html, body, #root, main { background: transparent !important; }
      body * { visibility: hidden !important; }
      [data-shot-keep], [data-shot-keep] * { visibility: visible !important; }
    `,
  });
  await page.waitForTimeout(200);
}

/** Scroll the (virtualised) chat list until `text` sits `offset` px below its top. */
async function scrollChatTo(page, text, offset) {
  for (let step = 0; step < 40; step += 1) {
    const done = await page.evaluate(
      ({ text, offset }) => {
        const scrollers = [...document.querySelectorAll("*")].filter(
          (el) =>
            el.scrollHeight > el.clientHeight + 4 &&
            /auto|scroll/.test(getComputedStyle(el).overflowY),
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
        list.scrollTop +=
          hit.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
        return true;
      },
      { text, offset },
    );
    await page.waitForTimeout(250);
    if (done) return;
  }
  throw new Error(`text never mounted: ${text}`);
}

/**
 * Hide the web build's nudges (age prompt, "get the desktop app"): the README
 * describes the desktop app, where neither appears.
 */
async function hideNudges(page) {
  await page.evaluate(() => {
    for (const label of ["Yaşını doğrula", "Masaüstü uygulamasını indir"]) {
      const leaf = [...document.querySelectorAll("button, a")].find(
        (el) => el.textContent?.trim() === label,
      );
      if (!leaf) continue;
      let box = leaf;
      while (box.parentElement && box.parentElement.getBoundingClientRect().height < 120)
        box = box.parentElement;
      box.style.display = "none";
    }
  });
  await page.waitForTimeout(300);
}

/** Replace text in every text node and title under `root` (fixture names only). */
async function rename(page, rootSelector, pairs) {
  await page.evaluate(
    ({ rootSelector, pairs }) => {
      const root = document.querySelector(rootSelector) ?? document.body;
      const walker = document.createTreeWalker(root, 4);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let text = node.textContent ?? "";
        for (const [from, to] of pairs) text = text.split(from).join(to);
        if (text !== node.textContent) node.textContent = text;
      }
      for (const el of root.querySelectorAll("[title], [aria-label]")) {
        for (const attr of ["title", "aria-label"]) {
          let t = el.getAttribute(attr);
          if (t === null) continue;
          for (const [from, to] of pairs) t = t.split(from).join(to);
          el.setAttribute(attr, t);
        }
      }
    },
    { rootSelector, pairs },
  );
}

/**
 * The picker fixture names real third-party apps in its window list; the
 * README shows no other brands, so labels and thumbnails are swapped for
 * neutral ones before the shot (the component itself is untouched).
 */
async function neutralWindows(page) {
  await rename(page, "[data-testid=source-picker]", [
    [
      "Çok uzun bir pencere başlığı olan bir tarayıcı sekmesi — YouTube",
      "Tatil fotoğrafları — tarayıcı",
    ],
    ["Netflix — Yüzüklerin Efendisi", "Film — tarayıcı"],
    ["Visual Studio Code", "Kod editörü"],
    ["Spotify Premium", "Müzik çalar"],
    ["Netflix", "Film"],
    ["Spotify", "Müzik"],
    ["YouTube", "Video"],
  ]);
  await page.evaluate(() => {
    const repaint = (label, hue) => {
      const c = document.createElement("canvas");
      c.width = 320;
      c.height = 180;
      const ctx = c.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, 320, 180);
      g.addColorStop(0, `hsl(${hue} 30% 26%)`);
      g.addColorStop(1, `hsl(${hue + 20} 30% 10%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fillRect(0, 0, 320, 18);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "600 16px sans-serif";
      ctx.fillText(label, 14, 100);
      return c.toDataURL("image/png");
    };
    const imgs = [...document.querySelectorAll("[data-testid=source-picker] img")].filter(
      (img) => img instanceof HTMLImageElement,
    );
    const plan = [
      ["Film", 15],
      ["Kod editörü", 220],
      ["Müzik", 150],
    ];
    imgs.slice(0, 3).forEach((img, i) => {
      img.src = repaint(plan[i][0], plan[i][1]);
    });
  });
  await page.waitForTimeout(400);
}

/**
 * The shell harness opens #sohbet as an empty, loaded conversation. Write a
 * short invented conversation into the SAME query cache instance the harness
 * seeded (same module URL → same module), the way the API would fill it.
 */
async function seedShellConversation(page) {
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((n) => /\/renderer\/src\/lib\/query-client\.ts/.test(n));
    if (!url) throw new Error("query-client module not loaded");
    const { queryClient, queryKeys } = await import(/* @vite-ignore */ url);
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const msg = (id, authorId, minutesAgo, content, extra = {}) => ({
      id,
      channelId: "c-sohbet",
      authorId,
      content,
      kind: "user",
      createdAt: at(minutesAgo),
      updatedAt: null,
      deletedAt: null,
      reactions: [],
      ...extra,
    });
    const oldestFirst = [
      msg("r01", "u-kaan", 95, "Bu akşam film gecesi hâlâ geçerli mi?"),
      msg("r02", "u-ece", 93, "Geçerli. 21:30'da **akşam odası**nda buluşuyoruz."),
      msg("r03", "u-ece", 92, "Ekranı ben paylaşırım, sesi de açık olur.", {
        reactions: [
          { emoji: "👍", count: 3, reactedByMe: true },
          { emoji: "🍿", count: 2, reactedByMe: false },
        ],
      }),
      msg("r04", "u-baran", 70, "Ben biraz geç katılırım, başlayın siz."),
      msg("r05", "u-deniz", 41, "Hangi filmi izliyoruz? Oylamaya iki aday koydum."),
      msg("r06", "u-me", 38, "İkincisi olsun, ilkini geçen hafta izledik.", {
        replyTo: {
          id: "r05",
          authorId: "u-deniz",
          content: "Hangi filmi izliyoruz? Oylamaya iki aday koydum.",
          kind: "user",
          deleted: false,
        },
        replyToMessageId: "r05",
        reactions: [{ emoji: "✅", count: 4, reactedByMe: false }],
      }),
      msg("r07", "u-can", 12, "Çayı ben demliyorum, gelen bardağını alsın 🫖"),
      msg("r08", "u-ece", 3, "Odaya girdim, sizi bekliyorum."),
    ];
    queryClient.setQueryData(queryKeys.messages("c-sohbet"), {
      pages: [{ messages: [...oldestFirst].reverse(), nextCursor: null }],
      pageParams: [null],
    });
  });
  await page.waitForTimeout(1200);
}

/** Hide the chat harness's own scene nav (not product UI) and its jump pill. */
async function chatHarnessChrome(page) {
  await page.addStyleTag({ content: "nav{display:none!important}" });
}
async function hideJumpPill(page) {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if (/atla|Jump to/i.test(b.textContent ?? "")) b.style.visibility = "hidden";
    }
  });
}

/**
 * Each shot: harness URL + stage(page) → element selector | null.
 * A null selector means the whole viewport.
 */
const SHOTS = {
  chat: {
    url: "/harness-shell.html?scene=shell&lang=tr",
    async stage(page) {
      await seedShellConversation(page);
      await hideNudges(page);
      return null;
    },
  },
  voice: {
    url: "/harness-voice.html?lng=tr",
    async stage(page) {
      await page.locator("[data-testid=stage-box]").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      // The fixture's first participant carries a real person's surname.
      await rename(page, "[data-testid=stage-box]", [["Ali Karagöz", "Ali Kaya"]]);
      return "[data-testid=stage-box]";
    },
  },
  "screen-share-picker": {
    url: "/harness-voice.html?lng=tr&picker=desktop",
    async stage(page) {
      await page.locator("[data-testid=open-picker]").click();
      await page.waitForTimeout(1200);
      const dialog = page.getByTestId("source-picker");
      // A film in a window: the recommended path, "only this app's sound".
      await dialog.getByText("Netflix — Yüzüklerin Efendisi", { exact: true }).first().click();
      await page.waitForTimeout(300);
      await dialog.getByText("Yalnız bu uygulama", { exact: true }).first().click();
      await page.waitForTimeout(600);
      await neutralWindows(page);
      return "[data-testid=source-picker]";
    },
  },
  "settings-microphone": {
    url: "/harness-settings.html?view=settings",
    async stage(page) {
      await page.getByRole("button", { name: "Mikrofon", exact: true }).first().click();
      await page.waitForTimeout(1500);
      return null;
    },
  },
  "avatar-crop": {
    url: "/harness-profile.html?view=crop",
    async stage(page) {
      await page.locator("[data-testid=crop-avatar-photo]").click();
      await page.waitForTimeout(1800);
      await rename(page, "[role=dialog]", [["Ali Karagöz", "Ali Kaya"]]);
      return "[role=dialog]";
    },
  },
  search: {
    url: "/harness-chat.html?lang=tr",
    async stage(page) {
      await chatHarnessChrome(page);
      await scrollChatTo(page, "Selam herkese", 24);
      await page.waitForTimeout(900);
      await scrollChatTo(page, "Selam herkese", 24);
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: "Ara", exact: true }).first().click();
      await page.waitForTimeout(800);
      await page.keyboard.type("çay");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2000);
      await hideJumpPill(page);
      return null;
    },
  },
};

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const wanted = Object.entries(SHOTS).filter(([name]) => !only.length || only.includes(name));
  if (!wanted.length) throw new Error(`unknown shot(s): ${only.join(", ")}`);

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
    for (const [name, shot] of wanted) {
      const context = await browser.newContext({
        baseURL: base,
        viewport: DESKTOP,
        deviceScaleFactor: SCALE,
        reducedMotion: "reduce",
        colorScheme: "dark",
      });
      context.setDefaultNavigationTimeout(180_000);
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") problems.push(`${name}: ${m.text()}`);
      });
      page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
      await page.goto(shot.url);
      await settle(page);
      const selector = await shot.stage(page);
      await rest(page);
      let png;
      if (selector) {
        await isolate(page, selector);
        png = await page
          .locator("[data-shot-keep]")
          .screenshot({ type: "png", omitBackground: true });
      } else {
        png = await page.screenshot({ type: "png" });
      }
      const { width } = await sharp(png).metadata();
      const resized = width > MAX_WIDTH ? sharp(png).resize({ width: MAX_WIDTH }) : sharp(png);
      const webp = await resized.webp(WEBP).toBuffer();
      const meta = await sharp(webp).metadata();
      writeFileSync(join(OUT, `${name}.webp`), webp);
      console.log(
        `${name}.webp  ${meta.width}×${meta.height}  ${(webp.length / 1024).toFixed(0)} KB`,
      );
      await context.close();
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
