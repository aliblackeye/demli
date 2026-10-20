/**
 * Shell data seam (Phase 1). The typed contract + <AppDataProvider> / useShellData()
 * that the shared shell-edge components read their data from. See ./shell-data.
 */
export {
  AppDataProvider,
  useShellData,
  type AppDataProviderProps,
  type ShellData,
  type ActiveView,
  type HomeView,
  type UnreadState,
  type HomeRowUnread,
  type ShellGroup,
  type ShellDmRow,
  type ShellGroupChatRow,
  type ShellMember,
  type ShellMemberRole,
  type GroupChatsStatus,
} from "./shell-data";
export {
  ChatDataProvider,
  useChatData,
  type ChatDataProviderProps,
  type ChatData,
  type ChatMessageView,
  type ChatDeliveryState,
  type ChatMessageRowContext,
  type ChatHeaderControls,
  type ChatIntro,
} from "./chat-data";
export {
  MessageRowServicesProvider,
  useMessageRowServices,
  useOptionalMessageRowServices,
  type MessageRowServices,
  type MessageRowServicesProviderProps,
} from "./message-row-data";
export {
  ComposerServicesProvider,
  useComposerServices,
  type ComposerServices,
  type ComposerServicesProviderProps,
  type ComposerDirectoryUser,
  type ComposerReplyTarget,
  type ComposerAttachmentDraft,
  type ComposerAttachmentDrafts,
  type ComposerSendAttachments,
  type ComposerReplyPayload,
  type ComposerSendBlock,
} from "./composer-data";
export {
  requestMentionInsert,
  onMentionInsert,
  type MentionInsertRequest,
} from "./mention-insert";
export {
  requestEditLastMessage,
  onEditLastRequest,
  requestMessageEdit,
  onMessageEditRequest,
  requestComposerFocus,
  onComposerFocusRequest,
} from "./edit-request";
