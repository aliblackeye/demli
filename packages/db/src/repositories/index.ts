import type { Db } from "../client.js";
import { attachmentsRepo } from "./attachments.js";
import { callUpgradeRepo } from "./call-upgrade.js";
import { callsRepo } from "./calls.js";
import { channelAccessRepo } from "./channel-access.js";
import { channelCategoriesRepo } from "./channel-categories.js";
import { channelsRepo } from "./channels.js";
import { moderationActionsRepo } from "./moderation-actions.js";
import { userBlocksRepo } from "./user-blocks.js";
import { userIgnoresRepo } from "./user-ignores.js";
import { userNotesRepo } from "./user-notes.js";
import { customEmojisRepo } from "./custom-emojis.js";
import { devicePreferencesRepo } from "./device-preferences.js";
import { deviceTokensRepo } from "./device-tokens.js";
import { dmsRepo } from "./dms.js";
import { friendshipsRepo } from "./friendships.js";
import { groupBansRepo } from "./group-bans.js";
import { groupChatsRepo } from "./group-chats.js";
import { groupsRepo } from "./groups.js";
import { invitesRepo } from "./invites.js";
import { messageEmbedsRepo } from "./message-embeds.js";
import { messagePinsRepo } from "./message-pins.js";
import { messageReactionsRepo } from "./message-reactions.js";
import { messagesRepo } from "./messages.js";
import { notificationMutesRepo } from "./notification-mutes.js";
import { rolesRepo } from "./roles.js";
import { sessionsRepo } from "./sessions.js";
import { usersRepo } from "./users.js";

/** Repository-style query layer over the drizzle client. */
export function createRepositories(db: Db) {
  return {
    users: usersRepo(db),
    sessions: sessionsRepo(db),
    groups: groupsRepo(db),
    groupBans: groupBansRepo(db),
    groupChats: groupChatsRepo(db),
    channels: channelsRepo(db),
    messages: messagesRepo(db),
    messageReactions: messageReactionsRepo(db),
    messageEmbeds: messageEmbedsRepo(db),
    messagePins: messagePinsRepo(db),
    customEmojis: customEmojisRepo(db),
    invites: invitesRepo(db),
    devicePreferences: devicePreferencesRepo(db),
    deviceTokens: deviceTokensRepo(db),
    roles: rolesRepo(db),
    channelAccess: channelAccessRepo(db),
    attachments: attachmentsRepo(db),
    friendships: friendshipsRepo(db),
    dms: dmsRepo(db),
    calls: callsRepo(db),
    callUpgrade: callUpgradeRepo(db),
    notificationMutes: notificationMutesRepo(db),
    // M18 (migration 0019)
    channelCategories: channelCategoriesRepo(db),
    userBlocks: userBlocksRepo(db),
    moderationActions: moderationActionsRepo(db),
    // Member context menu (migration 0020, ADR 0019)
    userNotes: userNotesRepo(db),
    userIgnores: userIgnoresRepo(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

export * from "./users.js";
export * from "./sessions.js";
export * from "./groups.js";
export * from "./group-bans.js";
export * from "./group-chats.js";
export * from "./channels.js";
export * from "./messages.js";
export * from "./message-reactions.js";
export * from "./message-embeds.js";
export * from "./message-pins.js";
export * from "./custom-emojis.js";
export * from "./invites.js";
export * from "./device-preferences.js";
export * from "./device-tokens.js";
export * from "./roles.js";
export * from "./channel-access.js";
export * from "./attachments.js";
export * from "./friendships.js";
export * from "./dms.js";
export * from "./calls.js";
export * from "./call-upgrade.js";
export * from "./notification-mutes.js";
export * from "./channel-categories.js";
export * from "./user-blocks.js";
export * from "./moderation-actions.js";
export * from "./user-notes.js";
export * from "./user-ignores.js";
