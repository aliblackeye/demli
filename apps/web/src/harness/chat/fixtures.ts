/**
 * Fixture world for the chat harness (DEV ONLY — see ../../../harness-chat.html).
 *
 * One small server ("Çay Ocağı") whose #genel history exercises every state the
 * messaging surface renders: three calendar days, grouped and broken runs, a
 * reply (live and deleted), mentions (of you, of someone else, @everyone),
 * reactions (yours and others', a custom emoji), an edited message, a pinned
 * message, the full markdown set, link + invite embeds, single / 2-up / 3-up
 * image grids, a broken attachment, a system join notice, an unread line, and
 * the two outbox states (queued offline, failed with retry).
 *
 * Every image is an inline SVG data URI, so the harness needs no network and no
 * storage bucket. Times are relative to "now" so the date dividers always read
 * "Bugün" / "Dün" / a weekday on whatever day the harness runs.
 */
import type {
  Attachment,
  Channel,
  CustomEmoji,
  Dm,
  FriendGroup,
  InvitePreview,
  Message,
  MessageEmbed,
  PinnedMessage,
  User,
} from "@demli/types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A fixed wall-clock time `daysAgo` days back (local), e.g. at(1, 21, 5) = yesterday 21:05. */
function at(daysAgo: number, hour: number, minute: number): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** A soft gradient "photo" as an SVG data URI (no network). */
function photo(width: number, height: number, from: string, to: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/>` +
    `<stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<circle cx="${width * 0.72}" cy="${height * 0.3}" r="${Math.min(width, height) * 0.12}" fill="#ffffff" fill-opacity="0.35"/>` +
    `<text x="24" y="${height - 28}" font-family="Inter, sans-serif" font-size="${Math.round(height / 12)}" fill="#ffffff" fill-opacity="0.8">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A face-ish avatar as an SVG data URI. */
function face(bg: string, fg: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="${bg}"/><circle cx="48" cy="38" r="18" fill="${fg}"/>` +
    `<ellipse cx="48" cy="90" rx="34" ry="26" fill="${fg}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const GROUP_ID = "g-cay";
export const ME_ID = "u-me";

function user(id: string, username: string, displayName: string, avatarUrl: string | null): User {
  return { id, username, displayName, avatarUrl, isAdult: true, birthdate: "1994-03-02", createdAt: at(60, 12, 0) };
}

export const ME = user(ME_ID, "ali", "Ali", face("#3a2a24", "#ffb49c"));
export const DENIZ = user("u-deniz", "deniz", "Deniz", face("#1f2b2a", "#8fd1c4"));
export const MERT = user("u-mert", "mert", "Mert", null);
export const ELIF = user("u-elif", "elif", "Elif", face("#2a2233", "#c9b3f2"));
export const CAN = user("u-can", "can", "Can", null);
export const ZEYNEP = user("u-zeynep", "zeynep", "Zeynep Arslan-Yıldırımoğlu", face("#33281b", "#f2cf8f"));
export const USERS: User[] = [ME, DENIZ, MERT, ELIF, CAN, ZEYNEP];

export const GROUP: FriendGroup = {
  id: GROUP_ID,
  name: "Çay Ocağı",
  iconUrl: null,
  ownerId: ME_ID,
  kind: "server",
  createdAt: at(40, 12, 0),
};

function channel(id: string, name: string, extra: Partial<Channel> = {}): Channel {
  return { id, groupId: GROUP_ID, kind: "text", name, position: 0, createdAt: at(40, 12, 0), ...extra };
}

export const CHANNELS = {
  genel: channel("c-genel", "genel", { description: "Akşam çayı, oyun planı, her şey burada." }),
  slow: channel("c-slow", "duyurular", { slowmodeSeconds: 30, position: 1 }),
  empty: channel("c-empty", "yeni-kanal", { position: 2 }),
  loading: channel("c-loading", "yavaş-ağ", { position: 3 }),
  error: channel("c-error", "sunucu-hatası", { position: 4 }),
  nsfw: channel("c-nsfw", "gece-kuşları", { nsfw: true, position: 5 }),
} as const;

export const MEMBERS = USERS.map((u) => ({
  groupId: GROUP_ID,
  userId: u.id,
  role: u.id === ME_ID ? ("owner" as const) : ("member" as const),
  roleIds: [],
  joinedAt: at(30, 12, 0),
  user: u,
}));

/* ── Attachments ─────────────────────────────────────────────────────────── */

function attachment(id: string, messageId: string, width: number | null, height: number | null, kind: Attachment["kind"] = "image"): Attachment {
  return {
    id,
    messageId,
    channelId: CHANNELS.genel.id,
    uploaderId: DENIZ.id,
    kind,
    mime: kind === "image" ? "image/png" : kind === "audio" ? "audio/mpeg" : "video/mp4",
    sizeBytes: 482_000,
    width,
    height,
    durationMs: null,
    createdAt: at(1, 20, 0),
  };
}

/** attachmentId → the URL the fake "sign" endpoint hands back. Absent = deleted. */
export const ATTACHMENT_URLS: Record<string, string> = {
  "att-sunset": photo(1600, 1000, "#ff8464", "#3b1d6e", "Kadıköy, gün batımı"),
  "att-tea-1": photo(800, 800, "#7a3b1d", "#e8a46a", "Demlik"),
  "att-tea-2": photo(800, 800, "#2b3a2a", "#a7c49a", "Simit"),
  "att-tea-3": photo(800, 800, "#1d2b3b", "#8aa9d6", "Vapur"),
  "att-pair-1": photo(900, 1200, "#3b2a1d", "#d6b48a", "Masa 1"),
  "att-pair-2": photo(900, 1200, "#2a1d3b", "#b48ad6", "Masa 2"),
};

/* ── Messages (#genel, oldest → newest) ──────────────────────────────────── */

function msg(
  id: string,
  authorId: string,
  createdAt: string,
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    channelId: CHANNELS.genel.id,
    authorId,
    content,
    kind: "user",
    createdAt,
    updatedAt: null,
    deletedAt: null,
    reactions: [],
    ...extra,
  };
}

const sunsetEmbed: MessageEmbed = {
  url: "https://example.org/kadikoy-cay-bahcesi",
  title: "Kadıköy'ün en sakin çay bahçeleri",
  description:
    "Rıhtımdan Moda'ya uzanan yolda, akşamüstü güneşini kaçırmadan oturabileceğin yedi bahçe — fiyatlar, saatler ve en iyi masalar.",
  // Same-origin http(s) image from the dev server: the card only loads http(s)
  // embed images (a data: URI is refused by design), and this needs no network.
  imageUrl: new URL("/icon-512.png", window.location.origin).href,
  siteName: "Şehir Rehberi",
  fetchedAt: at(2, 19, 0),
};

const plainEmbed: MessageEmbed = {
  url: "https://example.org/blog/demleme",
  title: "Demleme süresi gerçekten fark eder mi?",
  description: "Kısa bir deney: aynı çay, dört farklı süre, kör tadım.",
  imageUrl: null,
  siteName: null,
  fetchedAt: at(1, 20, 0),
};

export const GENEL_MESSAGES: Message[] = [
  msg("m01", DENIZ.id, at(3, 21, 2), "Bu hafta sonu kim maç izlemeye geliyor?"),
  msg("m02", DENIZ.id, at(3, 21, 3), "Projeksiyonu ben getiririm, çay sizden 🙂"),
  msg("m03", MERT.id, at(3, 21, 9), "Ben varım. **Cumartesi** 20:00 gibi olur mu?", {
    reactions: [
      { emoji: "👍", count: 3, reactedByMe: true },
      { emoji: "⚽", count: 1, reactedByMe: false },
    ],
  }),
  msg("m04", ELIF.id, at(3, 21, 15), "@sys:member_joined", { kind: "system" }),
  msg("m05", ELIF.id, at(2, 18, 40), "Selam herkese! Davet için teşekkürler."),
  msg("m06", ME_ID, at(2, 18, 44), "Hoş geldin <@u-elif>! Masaya otur, demlik yeni koyuldu.", {
    reactions: [{ emoji: "🫖", count: 2, reactedByMe: false }],
  }),
  msg(
    "m07",
    ZEYNEP.id,
    at(2, 19, 1),
    "Şuna bakın: https://example.org/kadikoy-cay-bahcesi\nCumartesi buradan başlayalım mı?",
    { embeds: [sunsetEmbed] },
  ),
  msg("m08", CAN.id, at(2, 19, 6), "Fotoğraflar geldi:", {
    attachments: [
      attachment("att-tea-1", "m08", 800, 800),
      attachment("att-tea-2", "m08", 800, 800),
      attachment("att-tea-3", "m08", 800, 800),
    ],
  }),
  msg("m09", DENIZ.id, at(1, 20, 0), "Dünkü gün batımı, telefonla çektim:", {
    attachments: [attachment("att-sunset", "m09", 1600, 1000)],
    pinned: true,
  }),
  msg("m10", MERT.id, at(1, 20, 4), "Çok iyi olmuş!", {
    replyTo: { id: "m09", authorId: DENIZ.id, content: "Dünkü gün batımı, telefonla çektim:", kind: "user", deleted: false },
    replyToMessageId: "m09",
    reactions: [
      { emoji: "🔥", count: 4, reactedByMe: true },
      { emoji: ":demli:", count: 2, reactedByMe: false },
    ],
  }),
  msg(
    "m11",
    ELIF.id,
    at(1, 20, 12),
    "Markdown deneme:\n> alıntı satırı burada\n`inline kod`, ~~üstü çizili~~, *eğik* ve ||spoiler: maç 2-1 bitti||\n```\nconst demlik = { süre: 15, su: \"kaynar\" };\n```",
  ),
  msg("m12", ZEYNEP.id, at(1, 20, 30), "<@everyone> cumartesi saat 20:00, Moda. Gelemeyen haber versin.", {
    pinned: true,
  }),
  msg("m13", CAN.id, at(1, 21, 0), "Yazının linki: https://example.org/blog/demleme", {
    embeds: [plainEmbed],
  }),
  msg("m14", MERT.id, at(1, 21, 5), "Masaların ikisi de güzel:", {
    attachments: [attachment("att-pair-1", "m14", 900, 1200), attachment("att-pair-2", "m14", 900, 1200)],
  }),
  msg("m15", DENIZ.id, at(1, 21, 9), "Bu dosya silinmiş galiba:", {
    attachments: [attachment("att-gone", "m15", 1200, 800)],
  }),
  // ── unread line goes above m16 (watermark = m15) ──
  msg(
    "m16",
    ZEYNEP.id,
    at(0, 9, 12),
    "Günaydın! <@u-me> sunucuya katılmak isteyen arkadaşım için davet: https://app.getdemli.com/invite/CayEvi24",
  ),
  msg("m17", CAN.id, at(0, 9, 20), "Eski davet de duruyor ama süresi dolmuş: https://app.getdemli.com/invite/EskiKod1"),
  msg("m18", MERT.id, at(0, 9, 31), "Silinen mesaja yanıt örneği", {
    replyTo: { id: "m00", authorId: CAN.id, content: "", kind: "user", deleted: true },
    replyToMessageId: "m00",
  }),
  msg(
    "m19",
    ME_ID,
    at(0, 9, 40),
    "Akşam ben biraz geç kalabilirim, işten çıkınca yazarım. Bu arada uzun bir mesajın satır kırılımını da görelim: Moda sahilinden Fenerbahçe parkına kadar yürüyüp, dönüşte Bahariye'deki o küçük dükkândan simit almayı unutmayalım, geçen sefer bitmişti.",
    { updatedAt: at(0, 9, 42) },
  ),
  msg("m20", ME_ID, at(0, 9, 41), "Bir de çay bardaklarını getiren olursa süper olur."),
];

/** Pins for #genel (newest pin first, like the API). */
export const GENEL_PINS: PinnedMessage[] = [
  { message: GENEL_MESSAGES.find((m) => m.id === "m12") as Message, pinnedBy: ME_ID, pinnedAt: at(1, 20, 31) },
  { message: GENEL_MESSAGES.find((m) => m.id === "m09") as Message, pinnedBy: MERT.id, pinnedAt: at(1, 20, 5) },
];

/** Messages for the slow-mode channel. */
export const SLOW_MESSAGES: Message[] = [
  { ...msg("s1", ZEYNEP.id, at(0, 8, 0), "Duyuru kanalında yavaş mod açık: 30 saniyede bir mesaj."), channelId: CHANNELS.slow.id },
];

/* ── Invites ─────────────────────────────────────────────────────────────── */

export const INVITE_PREVIEWS: Record<string, InvitePreview> = {
  CayEvi24: {
    code: "CayEvi24",
    kind: "server",
    groupName: "Bostancı Oyun Gecesi",
    groupIconUrl: null,
    memberCount: 18,
    onlineCount: 5,
    createdAt: at(6, 12, 0),
    alreadyMember: false,
    groupId: "g-oyun",
    targetChannel: null,
  },
};

/* ── Custom emoji ────────────────────────────────────────────────────────── */

export const CUSTOM_EMOJIS: CustomEmoji[] = [
  {
    id: "e-demli",
    groupId: GROUP_ID,
    name: "demli",
    mime: "image/png",
    sizeBytes: 3000,
    createdBy: ME_ID,
    createdAt: at(10, 12, 0),
  },
];

export const CUSTOM_EMOJI_URLS: Record<string, string> = {
  "e-demli": (() => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
      `<path d="M14 26h32v14a14 14 0 0 1-14 14h-4a14 14 0 0 1-14-14z" fill="#ff8464"/>` +
      `<path d="M46 30h4a6 6 0 0 1 0 12h-4" fill="none" stroke="#ff8464" stroke-width="4"/>` +
      `<path d="M24 8c-4 6 4 8 0 14M34 8c-4 6 4 8 0 14" stroke="#ffa48c" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  })(),
};

/* ── A DM with a blocked peer (the composer's blocked state) ─────────────── */

export const BLOCKED_DM: Dm = {
  id: "dm-can",
  streamId: "c-dm-can",
  participant: CAN,
  createdAt: at(20, 12, 0),
};

export const DM_STREAM: Channel = {
  id: BLOCKED_DM.streamId,
  groupId: BLOCKED_DM.id,
  kind: "text",
  name: CAN.displayName,
  position: 0,
  createdAt: BLOCKED_DM.createdAt,
};
