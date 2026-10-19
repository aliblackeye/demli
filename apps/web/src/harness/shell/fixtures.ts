/**
 * Realistic fixture data for the SHELL harness — a friend group's evening, not
 * lorem ipsum. Every shape is typed against the real API surface
 * (`api.*` return types), so a contract change breaks the harness at compile
 * time instead of letting it render a lie.
 */
import type { api } from "../../../../desktop/src/renderer/src/lib/api-client";
import type {
  Channel,
  ChannelCategory,
  ChannelId,
  FriendGroup,
  GroupId,
  NotificationMute,
  User,
  UserId,
} from "@demli/types";

type GroupDetails = Awaited<ReturnType<typeof api.getGroupDetails>>;
type Dm = Awaited<ReturnType<typeof api.listDms>>["dms"][number];
type GroupChat = Awaited<ReturnType<typeof api.listGroupChats>>["groups"][number];
type Role = Awaited<ReturnType<typeof api.listRoles>>["roles"][number];

const CREATED = "2026-09-01T18:00:00.000Z";

/** A small SVG "photo" as a data URI (no network in the harness). */
function photo(hueA: number, hueB: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hueA} 45% 42%)"/><stop offset="1" stop-color="hsl(${hueB} 50% 22%)"/>` +
    `</linearGradient></defs><rect width="96" height="96" fill="url(#g)"/>` +
    `<circle cx="48" cy="38" r="17" fill="hsl(${hueA} 30% 80%)" opacity=".85"/>` +
    `<rect x="20" y="60" width="56" height="40" rx="28" fill="hsl(${hueA} 30% 80%)" opacity=".85"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function user(id: string, username: string, displayName: string, extra: Partial<User> = {}): User {
  return {
    id: id as UserId,
    username,
    displayName,
    avatarUrl: null,
    bio: null,
    bannerUrl: null,
    customStatus: null,
    createdAt: CREATED,
    ...extra,
  };
}

export const ME = user("u-me", "ali", "Ali", {
  avatarUrl: photo(18, 350),
  customStatus: "Film gecesi 21:30'da",
  birthdate: null,
  isAdult: false,
});

export const USERS: User[] = [
  ME,
  user("u-ece", "ece", "Ece", { avatarUrl: photo(160, 210) }),
  user("u-baran", "baran", "Baran"),
  user("u-kaan", "kaan", "Kaan", { customStatus: "Çay demleniyor" }),
  user("u-deniz", "deniz", "Deniz"),
  user("u-mert", "mert", "Mert"),
  user("u-selin", "selin", "Selin Aydın Karaca Uzunisimli"),
  user("u-can", "can", "Can"),
];

export const userById = (id: string): User => USERS.find((u) => u.id === id) ?? ME;

export const G_MASA = "g-masa" as GroupId;
export const G_OYUN = "g-oyun" as GroupId;
export const G_OKUL = "g-okul" as GroupId;
export const G_KITAP = "g-kitap" as GroupId;
export const G_MUZIK = "g-muzik" as GroupId;
export const G_EMPTY = "g-bos" as GroupId;
export const G_LOADING = "g-yukleniyor" as GroupId;

function group(id: GroupId, name: string, ownerId: string, extra: Partial<FriendGroup> = {}): FriendGroup {
  return {
    id,
    name,
    iconUrl: null,
    bannerUrl: null,
    ownerId: ownerId as UserId,
    kind: "server",
    systemChannelId: null,
    invitePolicy: "members",
    createdAt: CREATED,
    ...extra,
  };
}

export const GROUPS: FriendGroup[] = [
  group(G_MASA, "bizim masa", ME.id),
  group(G_OYUN, "Oyun Gecesi", "u-baran", { iconUrl: photo(260, 300) }),
  group(G_OKUL, "Okul Arkadaşları", "u-ece"),
  group(G_KITAP, "Kitap Kulübü", "u-kaan"),
  group(G_MUZIK, "Müzik Odası", "u-deniz"),
  group(G_EMPTY, "Yeni Sunucu", ME.id),
  group(G_LOADING, "Yavaş Bağlantı", "u-mert"),
];

const CAT_GENEL = "cat-genel";
const CAT_ARSIV = "cat-arsiv";

function channel(
  id: string,
  groupId: GroupId,
  name: string,
  kind: Channel["kind"],
  position: number,
  extra: Partial<Channel> = {},
): Channel {
  return {
    id: id as ChannelId,
    groupId,
    kind,
    name,
    position,
    createdAt: CREATED,
    categoryId: null,
    restricted: false,
    nsfw: false,
    ...extra,
  };
}

export const CH_SOHBET = "c-sohbet" as ChannelId;
export const CH_AKSAM = "c-aksam" as ChannelId;

export const MASA_CHANNELS: Channel[] = [
  channel(CH_SOHBET, G_MASA, "sohbet", "text", 0),
  channel("c-film", G_MASA, "film-listesi", "text", 1),
  channel("c-oyun", G_MASA, "oyun", "text", 2, { restricted: true }),
  channel("c-gece", G_MASA, "gece-yarisi", "text", 3, { nsfw: true }),
  channel(CH_AKSAM, G_MASA, "akşam odası", "voice", 0),
  channel("c-filmgecesi", G_MASA, "film gecesi", "voice", 1),
  channel("c-duyuru", G_MASA, "duyurular", "text", 0, { categoryId: CAT_GENEL }),
  channel("c-uzun", G_MASA, "çok-uzun-bir-kanal-adı-ki-satıra-sığmasın", "text", 1, {
    categoryId: CAT_GENEL,
  }),
  channel("c-eski", G_MASA, "eski-plan", "text", 0, { categoryId: CAT_ARSIV }),
];

export const MASA_CATEGORIES: ChannelCategory[] = [
  { id: CAT_GENEL, groupId: G_MASA, name: "Genel", position: 0, createdAt: CREATED },
  { id: CAT_ARSIV, groupId: G_MASA, name: "Arşiv", position: 1, createdAt: CREATED },
  { id: "cat-bos", groupId: G_MASA, name: "Boş kategori", position: 2, createdAt: CREATED },
];

export const ROLES: Role[] = [
  {
    id: "r-mod",
    groupId: G_MASA,
    name: "Moderatör",
    color: "#7aa2ff",
    position: 1,
    permissions: 0,
    createdAt: CREATED,
  } as unknown as Role,
];

function details(g: FriendGroup, channels: Channel[], memberIds: string[]): GroupDetails {
  return {
    group: g,
    channels,
    members: memberIds.map((id) => ({
      groupId: g.id,
      userId: id as UserId,
      role: id === g.ownerId ? "owner" : "member",
      roleIds: id === "u-ece" ? ["r-mod"] : [],
      nickname: null,
      user: userById(id),
    })) as GroupDetails["members"],
  };
}

const ALL_IDS = USERS.map((u) => u.id);

export const DETAILS: Record<string, GroupDetails> = {
  [G_MASA]: details(GROUPS[0]!, MASA_CHANNELS, ALL_IDS),
  [G_OYUN]: details(GROUPS[1]!, [channel("c-oyun-genel", G_OYUN, "genel", "text", 0)], ALL_IDS),
  [G_OKUL]: details(GROUPS[2]!, [channel("c-okul-genel", G_OKUL, "genel", "text", 0)], ALL_IDS),
  [G_KITAP]: details(GROUPS[3]!, [channel("c-kitap", G_KITAP, "bu-ay", "text", 0)], ALL_IDS),
  [G_MUZIK]: details(GROUPS[4]!, [channel("c-muzik", G_MUZIK, "çalma-listesi", "text", 0)], ALL_IDS),
  [G_EMPTY]: details(GROUPS[5]!, [], [ME.id]),
  // G_LOADING has NO details on purpose: its fetch never resolves (loading state).
};

/**
 * What G_LOADING's details request returns once it SUCCEEDS — only the fetch-
 * failed scenes serve it, on the retry after a refused first request.
 */
export const HEALED_DETAILS: GroupDetails = details(
  GROUPS[6]!,
  [
    channel("c-yavas-genel", G_LOADING, "genel", "text", 0),
    channel("c-yavas-ses", G_LOADING, "salon", "voice", 0),
  ],
  ALL_IDS,
);

export const DMS: Dm[] = [
  { id: "dm-ece", streamId: "s-dm-ece" as ChannelId, participant: userById("u-ece"), createdAt: CREATED },
  { id: "dm-baran", streamId: "s-dm-baran" as ChannelId, participant: userById("u-baran"), createdAt: CREATED },
  { id: "dm-kaan", streamId: "s-dm-kaan" as ChannelId, participant: userById("u-kaan"), createdAt: CREATED },
  { id: "dm-selin", streamId: "s-dm-selin" as ChannelId, participant: userById("u-selin"), createdAt: CREATED },
] as Dm[];

export const GROUP_CHATS: GroupChat[] = [
  { id: "gc-tatil" as GroupId, name: "Tatil planı", iconUrl: null, ownerId: ME.id, streamId: "s-gc-tatil" as ChannelId, createdAt: CREATED },
  { id: "gc-halisaha" as GroupId, name: "Halı saha", iconUrl: null, ownerId: "u-mert" as UserId, streamId: "s-gc-hali" as ChannelId, createdAt: CREATED },
];

export const MUTES: NotificationMute[] = [
  { userId: ME.id, scope: "channel", targetId: "c-film", mode: "all", until: null, createdAt: CREATED, updatedAt: null },
  { userId: ME.id, scope: "group", targetId: G_MUZIK, mode: "all", until: null, createdAt: CREATED, updatedAt: null },
];

export const PRESENCE: Record<string, "online" | "idle" | "dnd" | "offline"> = {
  "u-me": "online",
  "u-ece": "online",
  "u-baran": "idle",
  "u-kaan": "dnd",
  "u-deniz": "online",
  "u-mert": "offline",
  "u-selin": "offline",
  "u-can": "online",
};

/** Unread state across the rail and the active server's sidebar. */
export const UNREAD = {
  unreadChannelIds: {
    "c-oyun": true,
    "c-duyuru": true,
    "c-oyun-genel": true,
    "c-okul-genel": true,
    "c-kitap": true,
    "s-dm-baran": true,
    "s-dm-kaan": true,
    "s-gc-hali": true,
  } as Record<string, boolean>,
  mentionUnreadChannelIds: {
    "c-duyuru": true,
    "c-okul-genel": true,
    "s-dm-baran": true,
  } as Record<string, boolean>,
  unreadCounts: {
    "c-duyuru": 3,
    "c-oyun-genel": 0,
    "c-okul-genel": 12,
    "c-kitap": 0,
    "s-dm-baran": 2,
    "s-gc-hali": 0,
  } as Record<string, number>,
};
