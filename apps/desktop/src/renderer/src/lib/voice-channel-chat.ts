/**
 * Voice-channel chat rules — MOVED to `@demli/client-core`.
 *
 * The rules themselves (what activating a voice row does, which room entry its
 * menu offers, which controls its chat header shows) now live in
 * `packages/client-core/src/voice-channel-chat.ts`, because the mobile app needs
 * the SAME decisions and cannot import out of `apps/desktop`. A hand-written
 * second copy on mobile is exactly how the two surfaces drift apart on the
 * founder's most-used voice gesture, so there is one implementation and both
 * renderers read it.
 *
 * This module stays as a forwarding re-export so the renderer's existing imports
 * (`./voice-channel-chat`) and its unit tests keep pointing at one path while
 * the desktop tree is owned by another agent. It holds no logic; folding it away
 * is a mechanical follow-up (repoint the three importers at
 * `@demli/client-core`, delete this file).
 */

export type {
  VoiceChatHeaderAction,
  VoiceChatHeaderFacts,
  VoiceEngineStatus,
  VoiceMenuRoomAction,
  VoiceRowClickAction,
  VoiceSessionFacts,
} from "@demli/client-core";

export {
  isVoiceSessionFor,
  voiceChatHeaderActions,
  voiceMenuRoomAction,
  voiceRowClickAction,
} from "@demli/client-core";
