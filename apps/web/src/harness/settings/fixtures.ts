/**
 * Fixture data for the settings-area harness (dev only, never in a build).
 *
 * Realistic on purpose: Turkish names with ç/ğ/ı/ö/ş/ü, one overflow-length
 * name, a 120-member server for the long-list path, mixed presence, every call
 * outcome, a custom-bitrate voice channel. Shapes are the REAL wire DTOs from
 * @demli/types / @demli/client-core, so the components render exactly what
 * they render against the API.
 */
import type {
  Channel,
  ChannelCategory,
  CustomEmoji,
  Dm,
  FriendGroup,
  Group,
  Invite,
  Message,
  ModerationActionEntry,
  PresenceStatus,
  Role,
  SessionSummary,
  User,
} from "@demli/types";
import { PERMISSIONS } from "@demli/types";
import type { FriendWithUser, GroupMemberWithUser, RecentCall } from "@demli/client-core";

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

function user(id: string, username: string, displayName: string, createdMinutesAgo = 90_000): User {
  return {
    id: id as User["id"],
    username,
    displayName,
    avatarUrl: null,
    createdAt: ago(createdMinutesAgo),
  };
}

export const ME = user("u-me", "deniz", "Deniz Arslan");
export const BURAK = user("u-burak", "burak", "Burak Yıldız");
export const MERT = user("u-mert", "mert_k", "Mert Kaya");
export const CAN = user("u-can", "candemir", "Can Demir");
export const ELIF = user("u-elif", "elif.s", "Elif Şahin");
export const ZEYNEP = user("u-zeynep", "zeynep", "Zeynep Aydın");
export const ECE = user("u-ece", "ecekoc", "Ece Koç");
export const LONG = user(
  "u-long",
  "muhammed_emin_karaosmanoglu",
  "Muhammed Emin Karaosmanoğlu Çağdaş Öztürkoğlu",
);
export const OGUZ = user("u-oguz", "oguzhan", "Oğuzhan Güneş");
export const IREM = user("u-irem", "irem", "İrem Çelik");

const FIRST = ["Ahmet", "Ayşe", "Bora", "Cem", "Derya", "Emre", "Funda", "Gökhan", "Hande", "Işıl", "Kaan", "Lale"];
const LAST = ["Aksoy", "Bulut", "Çakır", "Doğan", "Erdem", "Fırat", "Gür", "Hızal", "Ilgaz", "Kurt"];

/** 110 generated members so the members tab is tested at "100+". */
export const CROWD: User[] = Array.from({ length: 110 }, (_, i) => {
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
  return user(`u-crowd-${i}`, `${first.toLowerCase()}${i}`, `${first} ${last}`);
});

export const NAMED_USERS = [ME, BURAK, MERT, CAN, ELIF, ZEYNEP, ECE, LONG, OGUZ, IREM];
export const ALL_USERS = [...NAMED_USERS, ...CROWD];

export const PRESENCE: Record<string, PresenceStatus> = {
  [ME.id]: "online",
  [BURAK.id]: "online",
  [MERT.id]: "idle",
  [CAN.id]: "dnd",
  [ELIF.id]: "online",
  [ZEYNEP.id]: "offline",
  [ECE.id]: "offline",
  [LONG.id]: "online",
  [OGUZ.id]: "offline",
  [IREM.id]: "idle",
};

/* ── Server ─────────────────────────────────────────────────────────────── */

export const SERVER_ID = "g-cekirdek";

export const SERVER: FriendGroup = {
  id: SERVER_ID as FriendGroup["id"],
  name: "Çekirdek Kadro",
  iconUrl: null,
  bannerUrl: null,
  ownerId: ME.id,
  kind: "server",
  systemChannelId: "c-genel" as FriendGroup["id"] as never,
  invitePolicy: "members",
  createdAt: ago(200_000),
};

export const CATEGORIES: ChannelCategory[] = [
  { id: "cat-sohbet" as ChannelCategory["id"], groupId: SERVER.id, name: "Sohbet", position: 0, createdAt: ago(190_000) },
  { id: "cat-ses" as ChannelCategory["id"], groupId: SERVER.id, name: "Ses", position: 1, createdAt: ago(190_000) },
];

const channel = (partial: Partial<Channel> & Pick<Channel, "id" | "name" | "kind" | "position">): Channel => ({
  groupId: SERVER.id,
  createdAt: ago(180_000),
  description: null,
  slowmodeSeconds: 0,
  nsfw: false,
  categoryId: null,
  ...partial,
});

export const CHANNELS: Channel[] = [
  channel({ id: "c-genel" as Channel["id"], name: "genel", kind: "text", position: 0, description: "Her şey burada başlar.", categoryId: CATEGORIES[0]!.id }),
  channel({ id: "c-oyunlar" as Channel["id"], name: "oyunlar", kind: "text", position: 1, slowmodeSeconds: 30, categoryId: CATEGORIES[0]!.id }),
  channel({ id: "c-gece" as Channel["id"], name: "gece-yarisi", kind: "text", position: 2, nsfw: true, categoryId: CATEGORIES[0]!.id }),
  channel({ id: "c-lobi" as Channel["id"], name: "Lobi", kind: "voice", position: 3, maxParticipants: 8, audioBitrateKbps: 64, categoryId: CATEGORIES[1]!.id }),
  // A pre-preset custom bitrate: the dialog must show it honestly, never snap it.
  channel({ id: "c-film" as Channel["id"], name: "Film gecesi", kind: "voice", position: 4, audioBitrateKbps: 256, categoryId: CATEGORIES[1]!.id }),
];

export const ROLES: Role[] = [
  { id: "r-mod" as Role["id"], groupId: SERVER.id, name: "Moderatör", color: "#3498db", position: 0, permissions: PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS, createdAt: ago(100_000) },
  { id: "r-oyuncu" as Role["id"], groupId: SERVER.id, name: "Oyuncu", color: "#43b581", position: 1, permissions: 0, createdAt: ago(90_000) },
  { id: "r-dj" as Role["id"], groupId: SERVER.id, name: "DJ", color: "#9b59b6", position: 2, permissions: PERMISSIONS.CREATE_INVITE, createdAt: ago(80_000) },
  { id: "r-renksiz" as Role["id"], groupId: SERVER.id, name: "Misafir dostu", color: null, position: 3, permissions: 0, createdAt: ago(70_000) },
];

function member(u: User, role: GroupMemberWithUser["role"], roleIds: string[] = []): GroupMemberWithUser {
  return {
    groupId: SERVER.id,
    userId: u.id,
    role,
    roleIds: roleIds as Role["id"][],
    nickname: null,
    joinedAt: ago(150_000),
    user: u,
  } as GroupMemberWithUser;
}

export const SERVER_MEMBERS: GroupMemberWithUser[] = [
  member(ME, "owner"),
  member(BURAK, "member", ["r-mod", "r-oyuncu"]),
  member(MERT, "member", ["r-oyuncu"]),
  member(CAN, "member", ["r-dj"]),
  member(ELIF, "member"),
  member(ZEYNEP, "guest"),
  member(LONG, "member", ["r-oyuncu", "r-dj", "r-renksiz"]),
  ...CROWD.map((u, i) => member(u, "member", i % 4 === 0 ? ["r-oyuncu"] : [])),
];

/** 1×1-ish SVG data URLs so the emoji previews render without a network. */
const svgEmoji = (glyph: string, bg: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${bg}"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="white">${glyph}</text></svg>`,
  )}`;

export const EMOJIS: CustomEmoji[] = [
  { id: "e-cay" as CustomEmoji["id"], groupId: SERVER.id, name: "cay", mime: "image/png", sizeBytes: 18_400, createdBy: ME.id, createdAt: ago(5_000) },
  { id: "e-kedi" as CustomEmoji["id"], groupId: SERVER.id, name: "kedi_bakis", mime: "image/webp", sizeBytes: 42_100, createdBy: BURAK.id, createdAt: ago(3_000) },
  { id: "e-gg" as CustomEmoji["id"], groupId: SERVER.id, name: "gg", mime: "image/png", sizeBytes: 6_000, createdBy: MERT.id, createdAt: ago(1_000) },
];

export const EMOJI_URLS: Record<string, string> = {
  "e-cay": svgEmoji("☕", "#7a3b26"),
  "e-kedi": svgEmoji("🐱", "#3b4a7a"),
  "e-gg": svgEmoji("GG", "#2b6b45"),
};

const logEntry = (
  id: string,
  action: ModerationActionEntry["action"]["action"],
  actor: User | null,
  target: User | null,
  minutesAgo: number,
  reason: string | null = null,
): ModerationActionEntry => ({
  action: {
    id,
    groupId: SERVER.id,
    actorId: actor?.id ?? null,
    targetId: (target?.id ?? "u-gone") as User["id"],
    action,
    reason,
    expiresAt: null,
    createdAt: ago(minutesAgo),
  },
  actor,
  target,
});

export const MOD_LOG_PAGE_1: ModerationActionEntry[] = [
  logEntry("m1", "timeout", BURAK, CROWD[3]!, 12, "Kanalda üst üste aynı mesaj."),
  logEntry("m2", "kick", ME, CROWD[7]!, 95),
  logEntry("m3", "voice_disconnect", BURAK, MERT, 300),
  logEntry("m4", "ban", ME, null, 2_000, "Davet bağlantısıyla reklam spamı, üç kez uyarıldı."),
  logEntry("m5", "unban", ME, CROWD[12]!, 4_000),
];
export const MOD_LOG_PAGE_2: ModerationActionEntry[] = [
  logEntry("m6", "timeout_remove", null, CROWD[3]!, 9_000),
  logEntry("m7", "kick", BURAK, CROWD[20]!, 20_000),
];

/* ── Account ────────────────────────────────────────────────────────────── */

export const SESSIONS: SessionSummary[] = [
  { id: "s-this", deviceName: "Masaüstü · Windows", platform: "desktop", lastSeenAt: ago(0), createdAt: ago(10_000), current: true },
  { id: "s-phone", deviceName: "Pixel 8", platform: "mobile", lastSeenAt: ago(42), createdAt: ago(30_000), current: false },
  { id: "s-old", deviceName: null, platform: "desktop", lastSeenAt: ago(60 * 24 * 9), createdAt: ago(90_000), current: false },
];

export const BLOCKS = [
  { user: OGUZ, createdAt: ago(60 * 24 * 40) },
  { user: LONG, createdAt: ago(60 * 24 * 3) },
];
export const IGNORES = [{ user: ECE, createdAt: ago(60 * 24 * 2) }];
export const NICKNAMES = [
  { user: BURAK, nickname: "Burak abi", updatedAt: ago(500) },
  { user: CAN, nickname: "DJ Can", updatedAt: ago(800) },
];

/* ── Social ─────────────────────────────────────────────────────────────── */

const friendship = (other: User, status: "pending" | "accepted", requestedBy: User) => ({
  userA: ME.id,
  userB: other.id,
  status,
  requestedBy: requestedBy.id,
  createdAt: ago(10_000),
  updatedAt: null,
});

export const FRIENDS: FriendWithUser[] = [BURAK, MERT, CAN, ELIF, ZEYNEP, LONG, IREM].map((u) => ({
  user: u,
  friendship: friendship(u, "accepted", u),
}));
export const INCOMING: FriendWithUser[] = [OGUZ, CROWD[0]!].map((u) => ({
  user: u,
  friendship: friendship(u, "pending", u),
}));
export const OUTGOING: FriendWithUser[] = [CROWD[1]!].map((u) => ({
  user: u,
  friendship: friendship(u, "pending", ME),
}));

export const DMS: Dm[] = [
  { id: "dm-burak" as Dm["id"], streamId: "st-dm-burak" as Dm["streamId"], participant: BURAK, createdAt: ago(20_000) },
  { id: "dm-elif" as Dm["id"], streamId: "st-dm-elif" as Dm["streamId"], participant: ELIF, createdAt: ago(30_000) },
];

export const GROUP_CHAT: Group = {
  id: "gc-haftasonu" as Group["id"],
  name: "Hafta Sonu Ekibi",
  iconUrl: null,
  ownerId: ME.id,
  streamId: "st-gc-haftasonu" as Group["streamId"],
  createdAt: ago(40_000),
};

export const GROUP_CHAT_MEMBERS: GroupMemberWithUser[] = [ME, BURAK, ELIF, MERT].map(
  (u, i) =>
    ({
      groupId: GROUP_CHAT.id,
      userId: u.id,
      role: i === 0 ? "owner" : "member",
      roleIds: [],
      nickname: null,
      joinedAt: ago(40_000),
      user: u,
    }) as GroupMemberWithUser,
);

export const GROUP_CHAT_INVITES: Invite[] = [
  {
    id: "inv-gc-1" as Invite["id"],
    groupId: GROUP_CHAT.id,
    code: "hJ3kPq7t",
    createdBy: ME.id,
    expiresAt: ahead(24 * 5),
    maxUses: 25,
    useCount: 4,
    createdAt: ago(2_000),
    targetChannelId: null,
  },
];

const message = (id: string, streamId: string, author: User, content: string, minutesAgo: number): Message =>
  ({
    id,
    channelId: streamId,
    authorId: author.id,
    content,
    kind: "user",
    createdAt: ago(minutesAgo),
    updatedAt: null,
    attachments: [],
    reactions: [],
  }) as unknown as Message;

export const MESSAGES: Record<string, Message[]> = {
  "st-dm-burak": [
    message("msg-1", "st-dm-burak", BURAK, "Akşam Lobi'de miyiz?", 64),
    message("msg-2", "st-dm-burak", ME, "Dokuzda oradayım, çayı demledim.", 60),
    message("msg-3", "st-dm-burak", BURAK, "Süper, Mert de gelecekmiş.", 58),
  ],
  "st-gc-haftasonu": [
    message("msg-4", "st-gc-haftasonu", ELIF, "Cumartesi kamp planı hâlâ geçerli mi?", 300),
    message("msg-5", "st-gc-haftasonu", MERT, "Hava güzel görünüyor, ben varım.", 280),
  ],
};

const call = (
  id: string,
  peer: User,
  media: RecentCall["media"],
  status: RecentCall["status"],
  direction: RecentCall["direction"],
  minutesAgo: number,
  durationSeconds: number | null = null,
): RecentCall => ({
  id: id as RecentCall["id"],
  dmId: (peer.id === BURAK.id ? "dm-burak" : "dm-elif") as RecentCall["dmId"],
  peer,
  media,
  status,
  direction,
  durationSeconds,
  createdAt: ago(minutesAgo),
});

export const CALLS_PAGE_1: RecentCall[] = [
  call("call-1", BURAK, "video", "ended", "outgoing", 30, 1_845),
  call("call-2", ELIF, "audio", "missed", "incoming", 180),
  call("call-3", MERT, "audio", "missed", "outgoing", 600),
  call("call-4", CAN, "audio", "declined", "incoming", 1_500),
  call("call-5", BURAK, "audio", "upgraded", "incoming", 3_000, 620),
  call("call-6", LONG, "video", "canceled", "outgoing", 6_000),
];
export const CALLS_PAGE_2: RecentCall[] = [
  call("call-7", ZEYNEP, "audio", "ended", "incoming", 12_000, 42),
  call("call-8", OGUZ, "audio", "ended", "outgoing", 20_000, 3_700),
];
