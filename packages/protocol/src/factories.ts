/**
 * Typed event constructors.
 *
 * Consumers (gateway, desktop client, tests) build events through these
 * factories so event-name string literals exist ONLY inside this package —
 * no magic strings anywhere else (CLAUDE.md §23/§24).
 */

import type { Channel } from "@demli/types";
import type {
  AppStatePayload,
  AuthSucceededPayload,
  CallAcceptedPayload,
  CallEndedPayload,
  CallInvitePayload,
  CallUpgradedPayload,
  ChannelAccessChangedPayload,
  ChannelDeletedPayload,
  ClientEventOf,
  ClientEventType,
  DmCreatedPayload,
  EmojiCreatedPayload,
  EmojiDeletedPayload,
  ErrorRaisedPayload,
  FriendRemovedPayload,
  FriendRequestAcceptedPayload,
  FriendRequestReceivedPayload,
  GroupChatAddedPayload,
  GroupDeletedPayload,
  GroupUpdatedPayload,
  MemberBannedPayload,
  MemberJoinedPayload,
  MemberKickedPayload,
  MemberLeftPayload,
  MemberRolesUpdatedPayload,
  MessageDTO,
  MessageDeletedPayload,
  MessageEmbedsUpdatedPayload,
  MessagePinnedPayload,
  MessageReactionPayload,
  MessageUnpinnedPayload,
  NotificationMuteUpdatedPayload,
  PresencePayload,
  RoleCreatedPayload,
  RoleDeletedPayload,
  RoleUpdatedPayload,
  SendMessagePayload,
  ServerEventOf,
  ServerEventType,
  ServerToClientEvent,
  SessionRevokedPayload,
  UserUpdatedPayload,
  RealtimeEnvelope,
  TypingPayload,
  VoiceJoinPayload,
  VoiceLeavePayload,
  VoiceDisconnectedPayload,
  VoiceParticipantPayload,
  VoiceResyncPayload,
  VoiceSessionReplacedPayload,
  BlocksUpdatedPayload,
  CategoryCreatedPayload,
  CategoryDeletedPayload,
  CategoryReorderedPayload,
  CategoryUpdatedPayload,
  CustomStatusUpdatedPayload,
  IgnoresUpdatedPayload,
  MemberNicknameUpdatedPayload,
  MemberTimeoutUpdatedPayload,
  UserNicknameUpdatedPayload,
  WatchControlPayload,
  WatchEndedPayload,
  WatchHostChangedPayload,
  WatchQueueAddPayload,
  WatchQueuePlayPayload,
  WatchQueueRemovePayload,
  WatchQueueReorderPayload,
  WatchQueueUpdatedPayload,
  WatchSessionStatePayload,
  WatchSetVideoPayload,
  WatchStartPayload,
  WatchStopPayload,
  WatchStoppedPayload,
  WatchTransferHostPayload,
  GameInvitePayload,
  GameAcceptPayload,
  GameDeclinePayload,
  GameMovePayload,
  GameInviteReceivedPayload,
  GameStartedPayload,
  GameMoveResultPayload,
  GameEndedPayload,
  GameDeclinedPayload,
} from "./events.js";

/**
 * Event-name constants for routing (switch cases, comparisons). Consumers use
 * these instead of spelling event names, so literals stay in this package.
 */
export const CLIENT_EVENT = {
  messageSend: "message.send",
  typingStart: "typing.start",
  typingStop: "typing.stop",
  presenceUpdate: "presence.update",
  presenceAppState: "presence.app_state",
  voiceJoin: "voice.join",
  voiceLeave: "voice.leave",
  watchStart: "watch.start",
  watchControl: "watch.control",
  watchSetVideo: "watch.set_video",
  watchTransferHost: "watch.transfer_host",
  watchStop: "watch.stop",
  watchQueueAdd: "watch.queue_add",
  watchQueueRemove: "watch.queue_remove",
  watchQueueReorder: "watch.queue_reorder",
  watchQueuePlay: "watch.queue_play",
  watchEnded: "watch.ended",
  gameInvite: "game.invite",
  gameAccept: "game.accept",
  gameDecline: "game.decline",
  gameMove: "game.move",
} as const satisfies Record<string, ClientEventType>;

export const SERVER_EVENT = {
  authSucceeded: "auth.succeeded",
  errorRaised: "error.raised",
  messageCreated: "message.created",
  messageUpdated: "message.updated",
  messageDeleted: "message.deleted",
  messageReactionAdded: "message.reaction_added",
  messageReactionRemoved: "message.reaction_removed",
  messageEmbedsUpdated: "message.embeds_updated",
  messagePinned: "message.pinned",
  messageUnpinned: "message.unpinned",
  emojiCreated: "emoji.created",
  emojiDeleted: "emoji.deleted",
  typingStarted: "typing.started",
  typingStopped: "typing.stopped",
  presenceUpdated: "presence.updated",
  voiceParticipantJoined: "voice.participant_joined",
  voiceParticipantLeft: "voice.participant_left",
  voiceSessionReplaced: "voice.session_replaced",
  voiceResync: "voice.resync",
  roleCreated: "role.created",
  roleUpdated: "role.updated",
  roleDeleted: "role.deleted",
  memberRolesUpdated: "member.roles_updated",
  channelAccessChanged: "channel.access_changed",
  channelCreated: "channel.created",
  channelUpdated: "channel.updated",
  channelDeleted: "channel.deleted",
  memberJoined: "member.joined",
  memberLeft: "member.left",
  memberKicked: "member.kicked",
  memberBanned: "member.banned",
  voiceDisconnected: "voice.disconnected",
  groupUpdated: "group.updated",
  groupDeleted: "group.deleted",
  friendRequestReceived: "friend.request_received",
  friendRequestAccepted: "friend.request_accepted",
  friendRemoved: "friend.removed",
  dmCreated: "dm.created",
  groupChatAdded: "group_chat.added",
  notificationMuteUpdated: "notification_mute.updated",
  callInvite: "call.invite",
  callAccepted: "call.accepted",
  callEnded: "call.ended",
  callUpgraded: "call.upgraded",
  sessionRevoked: "session.revoked",
  userUpdated: "user.updated",
  categoryCreated: "category.created",
  categoryUpdated: "category.updated",
  categoryDeleted: "category.deleted",
  categoryReordered: "category.reordered",
  customStatusUpdated: "user.custom_status_updated",
  blocksUpdated: "user.blocks_updated",
  memberNicknameUpdated: "member.nickname_updated",
  memberTimeoutUpdated: "member.timeout_updated",
  userNicknameUpdated: "user.nickname_updated",
  ignoresUpdated: "user.ignores_updated",
  watchStarted: "watch.started",
  watchState: "watch.state",
  watchHostChanged: "watch.host_changed",
  watchStopped: "watch.stopped",
  watchQueueUpdated: "watch.queue_updated",
  gameInviteReceived: "game.invite_received",
  gameStarted: "game.started",
  gameMoveResult: "game.move_result",
  gameEnded: "game.ended",
  gameDeclined: "game.declined",
} as const satisfies Record<string, ServerEventType>;

export const clientEvent = {
  messageSend: (payload: SendMessagePayload): ClientEventOf<"message.send"> => ({
    type: "message.send",
    payload,
  }),
  typingStart: (payload: TypingPayload): ClientEventOf<"typing.start"> => ({
    type: "typing.start",
    payload,
  }),
  typingStop: (payload: TypingPayload): ClientEventOf<"typing.stop"> => ({
    type: "typing.stop",
    payload,
  }),
  presenceUpdate: (payload: PresencePayload): ClientEventOf<"presence.update"> => ({
    type: "presence.update",
    payload,
  }),
  presenceAppState: (payload: AppStatePayload): ClientEventOf<"presence.app_state"> => ({
    type: "presence.app_state",
    payload,
  }),
  voiceJoin: (payload: VoiceJoinPayload): ClientEventOf<"voice.join"> => ({
    type: "voice.join",
    payload,
  }),
  voiceLeave: (payload: VoiceLeavePayload): ClientEventOf<"voice.leave"> => ({
    type: "voice.leave",
    payload,
  }),
  watchStart: (payload: WatchStartPayload): ClientEventOf<"watch.start"> => ({
    type: "watch.start",
    payload,
  }),
  watchControl: (payload: WatchControlPayload): ClientEventOf<"watch.control"> => ({
    type: "watch.control",
    payload,
  }),
  watchSetVideo: (payload: WatchSetVideoPayload): ClientEventOf<"watch.set_video"> => ({
    type: "watch.set_video",
    payload,
  }),
  watchTransferHost: (
    payload: WatchTransferHostPayload,
  ): ClientEventOf<"watch.transfer_host"> => ({
    type: "watch.transfer_host",
    payload,
  }),
  watchStop: (payload: WatchStopPayload): ClientEventOf<"watch.stop"> => ({
    type: "watch.stop",
    payload,
  }),
  watchQueueAdd: (payload: WatchQueueAddPayload): ClientEventOf<"watch.queue_add"> => ({
    type: "watch.queue_add",
    payload,
  }),
  watchQueueRemove: (
    payload: WatchQueueRemovePayload,
  ): ClientEventOf<"watch.queue_remove"> => ({
    type: "watch.queue_remove",
    payload,
  }),
  watchQueueReorder: (
    payload: WatchQueueReorderPayload,
  ): ClientEventOf<"watch.queue_reorder"> => ({
    type: "watch.queue_reorder",
    payload,
  }),
  watchQueuePlay: (payload: WatchQueuePlayPayload): ClientEventOf<"watch.queue_play"> => ({
    type: "watch.queue_play",
    payload,
  }),
  watchEnded: (payload: WatchEndedPayload): ClientEventOf<"watch.ended"> => ({
    type: "watch.ended",
    payload,
  }),
  gameInvite: (payload: GameInvitePayload): ClientEventOf<"game.invite"> => ({
    type: "game.invite",
    payload,
  }),
  gameAccept: (payload: GameAcceptPayload): ClientEventOf<"game.accept"> => ({
    type: "game.accept",
    payload,
  }),
  gameDecline: (payload: GameDeclinePayload): ClientEventOf<"game.decline"> => ({
    type: "game.decline",
    payload,
  }),
  gameMove: (payload: GameMovePayload): ClientEventOf<"game.move"> => ({
    type: "game.move",
    payload,
  }),
} as const;

export const serverEvent = {
  authSucceeded: (payload: AuthSucceededPayload): ServerEventOf<"auth.succeeded"> => ({
    type: "auth.succeeded",
    payload,
  }),
  errorRaised: (payload: ErrorRaisedPayload): ServerEventOf<"error.raised"> => ({
    type: "error.raised",
    payload,
  }),
  messageCreated: (payload: MessageDTO): ServerEventOf<"message.created"> => ({
    type: "message.created",
    payload,
  }),
  messageUpdated: (payload: MessageDTO): ServerEventOf<"message.updated"> => ({
    type: "message.updated",
    payload,
  }),
  messageDeleted: (payload: MessageDeletedPayload): ServerEventOf<"message.deleted"> => ({
    type: "message.deleted",
    payload,
  }),
  messageReactionAdded: (
    payload: MessageReactionPayload,
  ): ServerEventOf<"message.reaction_added"> => ({
    type: "message.reaction_added",
    payload,
  }),
  messageReactionRemoved: (
    payload: MessageReactionPayload,
  ): ServerEventOf<"message.reaction_removed"> => ({
    type: "message.reaction_removed",
    payload,
  }),
  messageEmbedsUpdated: (
    payload: MessageEmbedsUpdatedPayload,
  ): ServerEventOf<"message.embeds_updated"> => ({
    type: "message.embeds_updated",
    payload,
  }),
  messagePinned: (payload: MessagePinnedPayload): ServerEventOf<"message.pinned"> => ({
    type: "message.pinned",
    payload,
  }),
  messageUnpinned: (
    payload: MessageUnpinnedPayload,
  ): ServerEventOf<"message.unpinned"> => ({
    type: "message.unpinned",
    payload,
  }),
  emojiCreated: (payload: EmojiCreatedPayload): ServerEventOf<"emoji.created"> => ({
    type: "emoji.created",
    payload,
  }),
  emojiDeleted: (payload: EmojiDeletedPayload): ServerEventOf<"emoji.deleted"> => ({
    type: "emoji.deleted",
    payload,
  }),
  typingStarted: (payload: TypingPayload): ServerEventOf<"typing.started"> => ({
    type: "typing.started",
    payload,
  }),
  typingStopped: (payload: TypingPayload): ServerEventOf<"typing.stopped"> => ({
    type: "typing.stopped",
    payload,
  }),
  presenceUpdated: (payload: PresencePayload): ServerEventOf<"presence.updated"> => ({
    type: "presence.updated",
    payload,
  }),
  voiceParticipantJoined: (
    payload: VoiceParticipantPayload,
  ): ServerEventOf<"voice.participant_joined"> => ({
    type: "voice.participant_joined",
    payload,
  }),
  voiceParticipantLeft: (
    payload: VoiceParticipantPayload,
  ): ServerEventOf<"voice.participant_left"> => ({
    type: "voice.participant_left",
    payload,
  }),
  voiceSessionReplaced: (
    payload: VoiceSessionReplacedPayload,
  ): ServerEventOf<"voice.session_replaced"> => ({
    type: "voice.session_replaced",
    payload,
  }),
  voiceResync: (payload: VoiceResyncPayload): ServerEventOf<"voice.resync"> => ({
    type: "voice.resync",
    payload,
  }),
  roleCreated: (payload: RoleCreatedPayload): ServerEventOf<"role.created"> => ({
    type: "role.created",
    payload,
  }),
  roleUpdated: (payload: RoleUpdatedPayload): ServerEventOf<"role.updated"> => ({
    type: "role.updated",
    payload,
  }),
  roleDeleted: (payload: RoleDeletedPayload): ServerEventOf<"role.deleted"> => ({
    type: "role.deleted",
    payload,
  }),
  memberRolesUpdated: (
    payload: MemberRolesUpdatedPayload,
  ): ServerEventOf<"member.roles_updated"> => ({
    type: "member.roles_updated",
    payload,
  }),
  channelAccessChanged: (
    payload: ChannelAccessChangedPayload,
  ): ServerEventOf<"channel.access_changed"> => ({
    type: "channel.access_changed",
    payload,
  }),
  channelCreated: (payload: Channel): ServerEventOf<"channel.created"> => ({
    type: "channel.created",
    payload,
  }),
  channelUpdated: (payload: Channel): ServerEventOf<"channel.updated"> => ({
    type: "channel.updated",
    payload,
  }),
  channelDeleted: (payload: ChannelDeletedPayload): ServerEventOf<"channel.deleted"> => ({
    type: "channel.deleted",
    payload,
  }),
  memberJoined: (payload: MemberJoinedPayload): ServerEventOf<"member.joined"> => ({
    type: "member.joined",
    payload,
  }),
  memberLeft: (payload: MemberLeftPayload): ServerEventOf<"member.left"> => ({
    type: "member.left",
    payload,
  }),
  memberKicked: (payload: MemberKickedPayload): ServerEventOf<"member.kicked"> => ({
    type: "member.kicked",
    payload,
  }),
  memberBanned: (payload: MemberBannedPayload): ServerEventOf<"member.banned"> => ({
    type: "member.banned",
    payload,
  }),
  voiceDisconnected: (
    payload: VoiceDisconnectedPayload,
  ): ServerEventOf<"voice.disconnected"> => ({
    type: "voice.disconnected",
    payload,
  }),
  groupUpdated: (payload: GroupUpdatedPayload): ServerEventOf<"group.updated"> => ({
    type: "group.updated",
    payload,
  }),
  groupDeleted: (payload: GroupDeletedPayload): ServerEventOf<"group.deleted"> => ({
    type: "group.deleted",
    payload,
  }),
  friendRequestReceived: (
    payload: FriendRequestReceivedPayload,
  ): ServerEventOf<"friend.request_received"> => ({
    type: "friend.request_received",
    payload,
  }),
  friendRequestAccepted: (
    payload: FriendRequestAcceptedPayload,
  ): ServerEventOf<"friend.request_accepted"> => ({
    type: "friend.request_accepted",
    payload,
  }),
  friendRemoved: (payload: FriendRemovedPayload): ServerEventOf<"friend.removed"> => ({
    type: "friend.removed",
    payload,
  }),
  dmCreated: (payload: DmCreatedPayload): ServerEventOf<"dm.created"> => ({
    type: "dm.created",
    payload,
  }),
  groupChatAdded: (payload: GroupChatAddedPayload): ServerEventOf<"group_chat.added"> => ({
    type: "group_chat.added",
    payload,
  }),
  notificationMuteUpdated: (
    payload: NotificationMuteUpdatedPayload,
  ): ServerEventOf<"notification_mute.updated"> => ({
    type: "notification_mute.updated",
    payload,
  }),
  callInvite: (payload: CallInvitePayload): ServerEventOf<"call.invite"> => ({
    type: "call.invite",
    payload,
  }),
  callAccepted: (payload: CallAcceptedPayload): ServerEventOf<"call.accepted"> => ({
    type: "call.accepted",
    payload,
  }),
  callEnded: (payload: CallEndedPayload): ServerEventOf<"call.ended"> => ({
    type: "call.ended",
    payload,
  }),
  callUpgraded: (payload: CallUpgradedPayload): ServerEventOf<"call.upgraded"> => ({
    type: "call.upgraded",
    payload,
  }),
  sessionRevoked: (payload: SessionRevokedPayload): ServerEventOf<"session.revoked"> => ({
    type: "session.revoked",
    payload,
  }),
  userUpdated: (payload: UserUpdatedPayload): ServerEventOf<"user.updated"> => ({
    type: "user.updated",
    payload,
  }),
  categoryCreated: (
    payload: CategoryCreatedPayload,
  ): ServerEventOf<"category.created"> => ({
    type: "category.created",
    payload,
  }),
  categoryUpdated: (
    payload: CategoryUpdatedPayload,
  ): ServerEventOf<"category.updated"> => ({
    type: "category.updated",
    payload,
  }),
  categoryDeleted: (
    payload: CategoryDeletedPayload,
  ): ServerEventOf<"category.deleted"> => ({
    type: "category.deleted",
    payload,
  }),
  categoryReordered: (
    payload: CategoryReorderedPayload,
  ): ServerEventOf<"category.reordered"> => ({
    type: "category.reordered",
    payload,
  }),
  customStatusUpdated: (
    payload: CustomStatusUpdatedPayload,
  ): ServerEventOf<"user.custom_status_updated"> => ({
    type: "user.custom_status_updated",
    payload,
  }),
  blocksUpdated: (payload: BlocksUpdatedPayload): ServerEventOf<"user.blocks_updated"> => ({
    type: "user.blocks_updated",
    payload,
  }),
  memberNicknameUpdated: (
    payload: MemberNicknameUpdatedPayload,
  ): ServerEventOf<"member.nickname_updated"> => ({
    type: "member.nickname_updated",
    payload,
  }),
  memberTimeoutUpdated: (
    payload: MemberTimeoutUpdatedPayload,
  ): ServerEventOf<"member.timeout_updated"> => ({
    type: "member.timeout_updated",
    payload,
  }),
  userNicknameUpdated: (
    payload: UserNicknameUpdatedPayload,
  ): ServerEventOf<"user.nickname_updated"> => ({
    type: "user.nickname_updated",
    payload,
  }),
  ignoresUpdated: (payload: IgnoresUpdatedPayload): ServerEventOf<"user.ignores_updated"> => ({
    type: "user.ignores_updated",
    payload,
  }),
  watchStarted: (payload: WatchSessionStatePayload): ServerEventOf<"watch.started"> => ({
    type: "watch.started",
    payload,
  }),
  watchState: (payload: WatchSessionStatePayload): ServerEventOf<"watch.state"> => ({
    type: "watch.state",
    payload,
  }),
  watchHostChanged: (
    payload: WatchHostChangedPayload,
  ): ServerEventOf<"watch.host_changed"> => ({
    type: "watch.host_changed",
    payload,
  }),
  watchStopped: (payload: WatchStoppedPayload): ServerEventOf<"watch.stopped"> => ({
    type: "watch.stopped",
    payload,
  }),
  watchQueueUpdated: (
    payload: WatchQueueUpdatedPayload,
  ): ServerEventOf<"watch.queue_updated"> => ({
    type: "watch.queue_updated",
    payload,
  }),
  gameInviteReceived: (
    payload: GameInviteReceivedPayload,
  ): ServerEventOf<"game.invite_received"> => ({
    type: "game.invite_received",
    payload,
  }),
  gameStarted: (payload: GameStartedPayload): ServerEventOf<"game.started"> => ({
    type: "game.started",
    payload,
  }),
  gameMoveResult: (payload: GameMoveResultPayload): ServerEventOf<"game.move_result"> => ({
    type: "game.move_result",
    payload,
  }),
  gameEnded: (payload: GameEndedPayload): ServerEventOf<"game.ended"> => ({
    type: "game.ended",
    payload,
  }),
  gameDeclined: (payload: GameDeclinedPayload): ServerEventOf<"game.declined"> => ({
    type: "game.declined",
    payload,
  }),
} as const;

/** Wrap a server event in the sequenced envelope. */
export function makeEnvelope<E extends ServerToClientEvent>(
  event: E,
  seq: number,
  sentAt: Date = new Date(),
): RealtimeEnvelope<E> {
  return { event, seq, sentAt: sentAt.toISOString() };
}
