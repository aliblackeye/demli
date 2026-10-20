/**
 * Fixture data + API stubs for the identity harness (dev only, never bundled —
 * see ../../../harness-profile.html).
 *
 * The REAL components run against the REAL query hooks; only the transport is
 * replaced. Every `api.*` method the identity surfaces call is answered here
 * with realistic data and realistic latency; every other method rejects with a
 * NETWORK error and is recorded in `window.__harnessUnstubbed`, so a surface
 * that reaches for something unexpected is visible instead of silently hitting
 * the live backend.
 *
 * Images are generated in the page (canvas photo-likes, a hand-assembled
 * animated GIF) so the harness carries no binary assets.
 */

import { ApiClientError, api } from "../../../../desktop/src/renderer/src/lib/api-client";
import type {
  GroupId,
  PresencePlatform,
  PresenceStatus,
  Role,
  RoleId,
  User,
  UserId,
  UserProfile,
} from "@demli/types";

// ── People ─────────────────────────────────────────────────────────────────

export const GROUP_ID = "g-masa" as GroupId;

function user(id: string, username: string, displayName: string, extra: Partial<User> = {}): User {
  return {
    id: id as UserId,
    username,
    displayName,
    avatarUrl: null,
    bio: null,
    bannerUrl: null,
    customStatus: null,
    createdAt: "2025-03-14T19:20:00.000Z",
    ...extra,
  } as User;
}

/** Filled in by {@link installImages} once the canvas images exist. */
export const IMAGES = {
  portraitA: "",
  portraitB: "",
  landscape: "",
  wideBanner: "",
  animatedBanner: "",
};

export const ME = user("u-me", "ali", "Ali Karagöz", {
  bio: "Akşamları sesli odadayım. Film gecesi cuma.",
  customStatus: "Kod yazıyorum, 18:00'e kadar",
  birthdate: "1994-05-02",
  isAdult: true,
} as Partial<User>);

export const FRIEND = user("u-ece", "ece", "Ece Yılmaz", {
  bio: "Gece kuşu. Ekran paylaşımında sinema sever.\nKedi: Pamuk.",
  customStatus: "Pamuk'la film izliyor",
});
export const STRANGER = user("u-mert", "mertcan", "Mert Can Aydın");
export const INCOMING = user("u-burak", "burak.s", "Burak Şahin", {
  bio: "Sesli sohbetlere gece 11'den sonra.",
});
export const BLOCKED = user("u-kaan", "kaan", "Kaan Demir");
export const LONG_NAME = user(
  "u-long",
  "cok_uzun_bir_kullanici_adi_ornegi",
  "Mehmet Ali Kılıçdaroğlu-Yıldırımoğlu",
  { customStatus: "Uzun bir durum satırı: bugün akşama kadar toplantılardayım, mesajlara geç dönebilirim." },
);
export const LOADING = user("u-loading", "yukleniyor", "Yükleniyor Örnek");
export const FAILING = user("u-error", "hata", "Hata Örnek");

export const PEOPLE = [ME, FRIEND, STRANGER, INCOMING, BLOCKED, LONG_NAME, LOADING, FAILING];

export const PRESENCE: Record<string, PresenceStatus> = {
  "u-me": "online",
  "u-ece": "online",
  "u-mert": "idle",
  "u-burak": "dnd",
  "u-long": "online",
  "u-kaan": "offline",
};
export const PLATFORMS: Record<string, PresencePlatform> = { "u-burak": "mobile", "u-long": "mobile" };

const ROLES: Role[] = [
  { id: "r-1" as RoleId, groupId: GROUP_ID, name: "Masa sahibi", color: "#ff8464", position: 3, permissions: 0, createdAt: "" },
  { id: "r-2" as RoleId, groupId: GROUP_ID, name: "Film gecesi", color: "#7dd3fc", position: 2, permissions: 0, createdAt: "" },
  { id: "r-3" as RoleId, groupId: GROUP_ID, name: "Gece vardiyası", color: "#c4b5fd", position: 1, permissions: 0, createdAt: "" },
  { id: "r-4" as RoleId, groupId: GROUP_ID, name: "Renksiz rol", color: null, position: 0, permissions: 0, createdAt: "" },
] as unknown as Role[];

function profileOf(target: User): UserProfile | "loading" | "error" {
  switch (target.id) {
    case "u-loading":
      return "loading";
    case "u-error":
      return "error";
    case "u-me":
      return { user: ME, friendship: "none", roles: [ROLES[0]!], mutualServers: [] };
    case "u-ece":
      return {
        user: { ...FRIEND, avatarUrl: IMAGES.portraitA, bannerUrl: IMAGES.wideBanner } as User,
        friendship: "friends",
        roles: [ROLES[1]!, ROLES[2]!, ROLES[3]!],
        mutualServers: [
          { id: GROUP_ID, name: "Bizim Masa", iconUrl: null },
          { id: "g-2" as GroupId, name: "Cuma Film Kulübü", iconUrl: null },
        ],
      };
    case "u-mert":
      return { user: STRANGER, friendship: "none", roles: [], mutualServers: [] };
    case "u-burak":
      return {
        user: { ...INCOMING, avatarUrl: IMAGES.portraitB, bannerUrl: IMAGES.animatedBanner } as User,
        friendship: "incoming",
        roles: [ROLES[2]!],
      };
    case "u-kaan":
      return { user: BLOCKED, friendship: "none", blocked: true };
    case "u-long":
      return {
        user: { ...LONG_NAME, avatarUrl: IMAGES.landscape } as User,
        friendship: "outgoing",
        roles: ROLES,
      };
    default:
      return "error";
  }
}

// ── Controls the page toggles ──────────────────────────────────────────────

export const harnessControls = {
  /** When true, the NEXT avatar upload fails with a network error (then succeeds). */
  failNextAvatarUpload: false,
  /** Milliseconds each upload takes, so the step bar is visible. */
  uploadDelayMs: 900,
};

declare global {
  interface Window {
    __harnessUnstubbed: string[];
    __harnessCalls: Array<{ method: string; args: unknown[] }>;
  }
}

const delay = <T,>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => window.setTimeout(() => resolve(value), ms));

const networkError = (): ApiClientError =>
  new ApiClientError("NETWORK", "Can't reach the server. Check your connection.");

let me: User = ME;

/** The current "server" copy of the signed-in user (updated by uploads/patches). */
export function currentMe(): User {
  return me;
}

/** Replace the transport for every method the identity surfaces use. */
export function installApiStubs(onMeChanged: (user: User) => void): void {
  window.__harnessUnstubbed = [];
  window.__harnessCalls = [];
  const record = (method: string, args: unknown[]): void => {
    window.__harnessCalls.push({ method, args });
  };

  const stubs: Partial<Record<keyof typeof api, (...args: never[]) => Promise<unknown>>> = {
    getUserProfile: async (userId: UserId) => {
      record("getUserProfile", [userId]);
      const target = PEOPLE.find((p) => p.id === userId);
      const profile = target ? profileOf(target.id === me.id ? me : target) : "error";
      if (profile === "loading") return new Promise(() => undefined);
      if (profile === "error") {
        await delay(450, null);
        throw networkError();
      }
      return delay(380, { profile: target?.id === me.id ? { ...profile, user: me } : profile });
    },
    listUserNicknames: async () => delay(120, { nicknames: [] }),
    getUserNote: async (userId: UserId) =>
      delay(140, {
        note:
          userId === "u-ece"
            ? { viewerId: me.id, targetId: userId, body: "Okul arkadaşı, Pamuk'un sahibi", createdAt: "", updatedAt: "" }
            : null,
      }),
    setUserNote: async (userId: UserId, body: string | null) => {
      record("setUserNote", [userId, body]);
      return delay(400, { note: null });
    },
    listIgnores: async () => delay(120, { ignores: [] }),
    getGroupDetails: async () =>
      delay(160, {
        group: { id: GROUP_ID, name: "Bizim Masa", iconUrl: null, ownerId: me.id, kind: "server" },
        channels: [],
        members: PEOPLE.slice(0, 6).map((p) => ({
          groupId: GROUP_ID,
          userId: p.id,
          role: p.id === me.id ? "owner" : "member",
          roleIds: p.id === "u-ece" ? ["r-2", "r-3"] : [],
          nickname: null,
          timedOutUntil: p.id === "u-mert" ? new Date(Date.now() + 3_600_000).toISOString() : null,
          joinedAt: "",
          user: p,
        })),
      }),
    listRoles: async () => delay(150, { roles: ROLES }),
    sendFriendRequest: async (...args: never[]) => {
      record("sendFriendRequest", args);
      return delay(500, { status: "pending" });
    },
    acceptFriendRequest: async (...args: never[]) => {
      record("acceptFriendRequest", args);
      return delay(500, undefined);
    },
    removeFriendRequest: async (...args: never[]) => {
      record("removeFriendRequest", args);
      return delay(500, undefined);
    },
    unfriend: async (...args: never[]) => {
      record("unfriend", args);
      return delay(600, undefined);
    },
    blockUser: async (...args: never[]) => {
      record("blockUser", args);
      return delay(600, { block: {} });
    },
    unblockUser: async (...args: never[]) => {
      record("unblockUser", args);
      return delay(600, undefined);
    },
    kickMember: async (...args: never[]) => {
      record("kickMember", args);
      return delay(700, undefined);
    },
    banMember: async (...args: never[]) => {
      record("banMember", args);
      return delay(700, { ban: {} });
    },
    timeoutMember: async (...args: never[]) => {
      record("timeoutMember", args);
      return delay(700, {});
    },
    removeMemberTimeout: async (...args: never[]) => {
      record("removeMemberTimeout", args);
      return delay(500, undefined);
    },
    setCustomStatus: async (input: { text: string; expiresInMinutes?: number }) => {
      record("setCustomStatus", [input]);
      me = { ...me, customStatus: input.text } as User;
      onMeChanged(me);
      return delay(500, { user: me });
    },
    clearCustomStatus: async () => {
      record("clearCustomStatus", []);
      me = { ...me, customStatus: null } as User;
      onMeChanged(me);
      return delay(400, { user: me });
    },
    uploadAvatar: async (input: { mime: string; dataBase64: string }) => {
      record("uploadAvatar", [{ mime: input.mime, bytes: Math.round((input.dataBase64.length * 3) / 4) }]);
      await delay(harnessControls.uploadDelayMs, null);
      if (harnessControls.failNextAvatarUpload) {
        harnessControls.failNextAvatarUpload = false;
        throw networkError();
      }
      me = { ...me, avatarUrl: `data:${input.mime};base64,${input.dataBase64}` } as User;
      onMeChanged(me);
      return { user: me };
    },
    uploadBanner: async (input: { mime: string; dataBase64: string }) => {
      record("uploadBanner", [{ mime: input.mime, bytes: Math.round((input.dataBase64.length * 3) / 4) }]);
      await delay(harnessControls.uploadDelayMs, null);
      me = { ...me, bannerUrl: `data:${input.mime};base64,${input.dataBase64}` } as User;
      onMeChanged(me);
      return { user: me };
    },
    updateMe: async (input: Record<string, unknown>) => {
      record("updateMe", [input]);
      await delay(500, null);
      me = { ...me, ...input } as User;
      onMeChanged(me);
      return { user: me };
    },
    deleteMe: async () => {
      record("deleteMe", []);
      return delay(500, undefined);
    },
    openDm: async (...args: never[]) => {
      record("openDm", args);
      return delay(300, { dm: { id: "dm-1", members: [] } });
    },
    listCustomEmojis: async () => delay(100, { emojis: [] }),
  };

  const target = api as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (typeof target[key] !== "function") continue;
    const stub = stubs[key as keyof typeof api];
    target[key] =
      stub ??
      (async (...args: unknown[]) => {
        window.__harnessUnstubbed.push(key);
        record(key, args);
        throw networkError();
      });
  }
}

// ── Images ─────────────────────────────────────────────────────────────────

/** A photo-like image: soft background light, a "head and shoulders" silhouette. */
function portrait(width: number, height: number, hue: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, `hsl(${hue} 45% 62%)`);
  bg.addColorStop(1, `hsl(${(hue + 50) % 360} 35% 22%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  const light = ctx.createRadialGradient(width * 0.25, height * 0.2, 0, width * 0.25, height * 0.2, width * 0.7);
  light.addColorStop(0, "rgba(255,255,255,0.55)");
  light.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = `hsl(${(hue + 180) % 360} 25% 18%)`;
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 1.02, width * 0.38, height * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `hsl(28 45% 62%)`;
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 0.46, width * 0.17, height * 0.21, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `hsl(20 40% 18%)`;
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 0.34, width * 0.19, height * 0.12, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  // Film grain, so downscaling quality is visible.
  const grain = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    grain.data[i] = Math.max(0, Math.min(255, grain.data[i]! + n));
    grain.data[i + 1] = Math.max(0, Math.min(255, grain.data[i + 1]! + n));
    grain.data[i + 2] = Math.max(0, Math.min(255, grain.data[i + 2]! + n));
  }
  ctx.putImageData(grain, 0, 0);
  return canvas;
}

/** A wide landscape: sky gradient, sun, layered hills. */
function landscape(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#1b2a49");
  sky.addColorStop(0.6, "#e0795b");
  sky.addColorStop(1, "#f3c27a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,236,200,0.9)";
  ctx.beginPath();
  ctx.arc(width * 0.68, height * 0.62, height * 0.12, 0, Math.PI * 2);
  ctx.fill();
  const layers = ["#3b2a3d", "#2a1f2f", "#171219"];
  layers.forEach((color, index) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += width / 24) {
      const y = height * (0.62 + index * 0.1) + Math.sin(x / (width / (5 + index)) + index) * height * 0.06;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.fill();
  });
  return canvas;
}

/**
 * A minimal UNCOMPRESSED animated GIF89a: 8-bit LZW codes written as literal
 * 9-bit codes with a clear code every 254 pixels, so the code size never grows.
 * Decoders accept it; it is just larger than a real encoder's output.
 */
export function makeAnimatedGif(width: number, height: number, frames: Array<(x: number, y: number) => number>, palette: number[][]): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const push = (...bytes: number[]): void => {
    out.push(...bytes);
  };
  const ascii = (text: string): void => push(...[...text].map((c) => c.charCodeAt(0)));
  ascii("GIF89a");
  push(width & 0xff, width >> 8, height & 0xff, height >> 8, 0xf7, 0, 0);
  for (let i = 0; i < 256; i += 1) {
    const [r, g, b] = palette[i] ?? [0, 0, 0];
    push(r!, g!, b!);
  }
  push(0x21, 0xff, 0x0b);
  ascii("NETSCAPE2.0");
  push(3, 1, 0, 0, 0);
  for (const pixel of frames) {
    push(0x21, 0xf9, 4, 0x04, 40, 0, 0, 0); // 400ms per frame
    push(0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0);
    push(8);
    const data: number[] = [];
    let acc = 0;
    let bits = 0;
    const code = (value: number): void => {
      acc |= value << bits;
      bits += 9;
      while (bits >= 8) {
        data.push(acc & 0xff);
        acc >>= 8;
        bits -= 8;
      }
    };
    let run = 0;
    code(256);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (run === 254) {
          code(256);
          run = 0;
        }
        code(pixel(x, y) & 0xff);
        run += 1;
      }
    }
    code(257);
    if (bits > 0) data.push(acc & 0xff);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      push(chunk.length, ...chunk);
    }
    push(0);
  }
  push(0x3b);
  return new Uint8Array(out);
}

/** 256-entry palette: a coral → night ramp. */
function rampPalette(): number[][] {
  return Array.from({ length: 256 }, (_, i) => {
    const t = i / 255;
    return [Math.round(20 + 235 * t), Math.round(18 + 114 * t), Math.round(40 + 60 * t)];
  });
}

export function animatedBannerBytes(): Uint8Array<ArrayBuffer> {
  const width = 240;
  const height = 90;
  const frame = (shift: number) => (x: number, y: number) => {
    const wave = Math.sin((x + shift) / 18) * 18 + height / 2;
    return y > wave ? Math.round((x / width) * 200 + 40) : Math.round((y / height) * 60);
  };
  return makeAnimatedGif(width, height, [frame(0), frame(20), frame(40)], rampPalette());
}

function canvasToFile(canvas: HTMLCanvasElement, name: string, type: string, quality?: number): Promise<File> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(new File([blob], name, { type })) : reject(new Error("toBlob failed"))),
      type,
      quality,
    ),
  );
}

/** Files the crop-editor demo opens. */
export interface HarnessFiles {
  photo: File;
  smallPhoto: File;
  landscape: File;
  animatedGif: File;
  stillFromGif: File;
  notAnImage: File;
  pixelBomb: File;
}

export async function makeHarnessFiles(): Promise<HarnessFiles> {
  const gif = animatedBannerBytes();
  // A PNG whose header claims 30000×30000 — the decompression-bomb shape.
  const bomb = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0x75, 0x30, 0, 0, 0x75, 0x30, 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ]);
  return {
    photo: await canvasToFile(portrait(1600, 1200, 18), "portre.jpg", "image/jpeg", 0.92),
    smallPhoto: await canvasToFile(portrait(220, 220, 200), "kucuk.png", "image/png"),
    landscape: await canvasToFile(landscape(2400, 1000), "manzara.jpg", "image/jpeg", 0.9),
    animatedGif: new File([gif], "dalga.gif", { type: "image/gif" }),
    stillFromGif: new File([gif], "avatar.gif", { type: "image/gif" }),
    notAnImage: new File([new TextEncoder().encode("bu bir metin dosyası")], "notlar.png", { type: "image/png" }),
    pixelBomb: new File([bomb], "dev.png", { type: "image/png" }),
  };
}

/** Fill {@link IMAGES} (data URLs, so `<img>` and CSP-free previews just work). */
export async function installImages(): Promise<void> {
  IMAGES.portraitA = portrait(512, 512, 330).toDataURL("image/webp", 0.9);
  IMAGES.portraitB = portrait(512, 512, 150).toDataURL("image/webp", 0.9);
  IMAGES.landscape = landscape(512, 512).toDataURL("image/webp", 0.9);
  IMAGES.wideBanner = landscape(1200, 450).toDataURL("image/webp", 0.9);
  const gif = animatedBannerBytes();
  let binary = "";
  for (const byte of gif) binary += String.fromCharCode(byte);
  IMAGES.animatedBanner = `data:image/gif;base64,${btoa(binary)}`;
}
