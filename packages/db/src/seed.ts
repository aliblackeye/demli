/**
 * Dev seed — WIPES all data, then inserts:
 * - 2 users: ali / mira (password for both: "demli-dev")
 * - 1 demo server "Demo Crew" (kind='server') with ali owner, mira member
 * - channels: #general (text), #games (text), Lobby (voice)
 * - ~30 messages in #general
 * - a "Moderator" role (MANAGE_MESSAGES | KICK_MEMBERS) assigned to mira, and a
 *   restricted #staff channel visible only to the owner + Moderators
 * - 1 flat group chat "Ali & Mira" (kind='group') with both users + a few
 *   messages in its single stream channel
 *
 * Run via: pnpm db:seed. Never run against anything but a dev database.
 */

import argon2 from "argon2";
import { createDb } from "./client.js";
import { createRepositories } from "./repositories/index.js";
import { PERMISSIONS } from "@demli/types";
import {
  attachments,
  channelRoleAccess,
  channels,
  devicePreferences,
  friendGroupMembers,
  friendGroups,
  friendships,
  invites,
  memberRoles,
  messageReactions,
  messages,
  roles,
  sessions,
  users,
} from "./schema.js";

const connectionString =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

const { db, close } = createDb(connectionString, { max: 1 });
const repos = createRepositories(db);

const SEED_PASSWORD = "demli-dev";

const banter = [
  "yo, anyone up for a round tonight?",
  "give me 10, grabbing food",
  "did you see that clutch yesterday? unreal",
  "I still have the clip somewhere",
  "post it in #games when you find it",
  "screen share worked way better after the update",
  "we should try the new co-op map",
  "I'm in after 9pm",
  "same, kids to bed first",
  "classic",
  "who broke the voice channel name again",
  "not me this time, I swear",
  "suspicious.",
  "ok tonight: lobby at 9, be there",
  "can someone invite Deniz already?",
  "sent him a code, he never redeems them",
  "typical Deniz",
  "btw the new mic sounds way cleaner",
  "yeah huge difference, what did you get?",
  "some dynamic one, I'll link it later",
  "link or it didn't happen",
  "haha fair",
  "anyone tried the ranked reset?",
  "placement matches were brutal",
  "carried, obviously",
  "sure you were",
  "ok I'm out for now, see you at 9",
  "later!",
  "don't be late this time",
  "no promises",
];

try {
  console.log("[seed] wiping existing data…");
  // Order respects FKs; cascade would also handle it but be explicit.
  await db.delete(attachments);
  await db.delete(messageReactions);
  await db.delete(channelRoleAccess);
  await db.delete(memberRoles);
  await db.delete(roles);
  await db.delete(messages);
  await db.delete(invites);
  await db.delete(devicePreferences);
  await db.delete(sessions);
  await db.delete(channels);
  await db.delete(friendships);
  await db.delete(friendGroupMembers);
  await db.delete(friendGroups);
  await db.delete(users);

  console.log("[seed] creating users…");
  const passwordHash = await argon2.hash(SEED_PASSWORD);
  const ali = await repos.users.create({
    username: "ali",
    displayName: "Ali",
    passwordHash,
  });
  const mira = await repos.users.create({
    username: "mira",
    displayName: "Mira",
    passwordHash,
  });

  console.log("[seed] creating demo group + channels…");
  const group = await repos.groups.create({ name: "Demo Crew", ownerId: ali.id });
  await repos.groups.addMember(group.id, mira.id, "member");

  const general = await repos.channels.create({
    groupId: group.id,
    kind: "text",
    name: "general",
  });
  await repos.channels.create({ groupId: group.id, kind: "text", name: "games" });
  await repos.channels.create({ groupId: group.id, kind: "voice", name: "Lobby" });

  console.log("[seed] writing messages…");
  let firstGeneralMsgId: string | undefined;
  for (const [i, content] of banter.entries()) {
    const m = await repos.messages.create({
      channelId: general.id,
      authorId: i % 2 === 0 ? ali.id : mira.id,
      content,
    });
    if (i === 0) firstGeneralMsgId = m.id;
  }

  console.log("[seed] adding a reply + a few reactions (M14)…");
  // A reply quoting the first #general message, so the UI has a preview to show.
  await repos.messages.create({
    channelId: general.id,
    authorId: mira.id,
    content: "reviving this — I'm in for tonight",
    replyToMessageId: firstGeneralMsgId,
  });
  // A handful of reactions on the quoted message: 👍 from both (count 2) + 🔥 solo.
  await repos.messageReactions.add(firstGeneralMsgId!, ali.id, "👍");
  await repos.messageReactions.add(firstGeneralMsgId!, mira.id, "👍");
  await repos.messageReactions.add(firstGeneralMsgId!, ali.id, "🔥");

  console.log("[seed] attaching a sample image…");
  // One image attachment on a #general message, walked through the real
  // lifecycle (createPending → markReady → attachToMessage) so UI/tests have a
  // linked fixture. A synthetic storage_path is fine for dev (bucket-relative
  // key, per ADR 0008); no real bytes exist locally.
  const shotMsg = await repos.messages.create({
    channelId: general.id,
    authorId: ali.id,
    content: "here's that screenshot from last night",
  });
  const pendingShot = await repos.attachments.createPending({
    channelId: general.id,
    uploaderId: ali.id,
    kind: "image",
    mime: "image/png",
    sizeBytes: 248_000,
    width: 1280,
    height: 720,
    storagePath: `attachments/${general.id}/seed-screenshot.png`,
  });
  await repos.attachments.markReady(pendingShot.id, {
    uploaderId: ali.id,
    width: 1280,
    height: 720,
  });
  await repos.attachments.attachToMessage([pendingShot.id], shotMsg.id, ali.id);

  console.log("[seed] creating a role + restricted channel…");
  // A "Moderator" role that can moderate messages and kick, granted to mira.
  const moderator = await repos.roles.create({
    groupId: group.id,
    name: "Moderator",
    color: "#22c55e",
    permissions: PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS,
  });
  await repos.roles.assign(group.id, mira.id, moderator.id);

  // A restricted #staff channel visible only to the owner (ali) + Moderators.
  const staff = await repos.channels.create({
    groupId: group.id,
    kind: "text",
    name: "staff",
  });
  await repos.channelAccess.setChannelRoles(group.id, staff.id, [moderator.id]);
  await repos.messages.create({
    channelId: staff.id,
    authorId: ali.id,
    content: "mods only — keep it civil down there",
  });

  console.log("[seed] creating demo group chat…");
  const groupChat = await repos.groupChats.create({ name: "Ali & Mira", ownerId: ali.id });
  await repos.groupChats.addMember(groupChat.id, mira.id, "member");

  const groupBanter: Array<{ authorId: string; content: string }> = [
    { authorId: ali.id, content: "hey, made us a group here" },
    { authorId: mira.id, content: "nice, way easier than the whole server thing" },
    { authorId: ali.id, content: "exactly — just us two, one thread" },
    { authorId: mira.id, content: "film night friday?" },
    { authorId: ali.id, content: "in. I'll share the screen" },
  ];
  for (const m of groupBanter) {
    await repos.messages.create({
      channelId: groupChat.streamId,
      authorId: m.authorId,
      content: m.content,
    });
  }

  console.log("[seed] creating friendship + DM (ali ↔ mira)…");
  // A profile bio for ali so the profile card has content in dev.
  await repos.users.updateProfile(ali.id, {
    bio: "building demli. voice-first, screen-share obsessed.",
  });
  // Accepted friendship: ali requests, mira accepts.
  await repos.friendships.send(ali.id, mira.id);
  await repos.friendships.accept(mira.id, ali.id);
  // A DM between the two friends with a short exchange.
  const { dm } = await repos.dms.getOrCreate(ali.id, mira.id);
  const dmBanter: Array<{ authorId: string; content: string }> = [
    { authorId: ali.id, content: "made us a DM — no group needed" },
    { authorId: mira.id, content: "clean. this is just us two right?" },
    { authorId: ali.id, content: "exactly. friends + a direct line" },
  ];
  for (const m of dmBanter) {
    await repos.messages.create({
      channelId: dm.streamId,
      authorId: m.authorId,
      content: m.content,
    });
  }

  console.log(
    `[seed] done — users ali/mira (password "${SEED_PASSWORD}"), server "Demo Crew" (${banter.length} messages in #general, "Moderator" role → mira, restricted #staff), group "Ali & Mira" (${groupBanter.length} messages), ali↔mira friendship + DM (${dmBanter.length} messages)`,
  );
} catch (err) {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
