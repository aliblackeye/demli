/** UI chrome state — dialogs, command menu, settings shell. Zustand only (CLAUDE.md §3). */

import { create } from "zustand";
import type { CategoryId, ChannelId, GroupId, UserId } from "@demli/types";

// "account" and "profile" are now a SINGLE combined panel (founder M15 request);
// "profile" is the surviving id — every `openSettings("profile")` entry point
// (user footer, profile-card "Edit profile") lands on the unified Account panel.
export type SettingsSection = "profile" | "sessions" | "voice" | "appearance";

/**
 * Which step the "add a server" dialog shows: the chooser, the create form, or
 * the invite-redeem form. Entry points pick one — the rail's `+` opens the
 * chooser, the command menu jumps straight to `create` / `join`.
 */
export type AddServerStep = "choose" | "create" | "join";

/**
 * How the channel-settings dialog was opened: the generic editor ("edit") or
 * straight to the delete confirmation ("delete", from the context-menu Delete).
 */
export type ChannelSettingsIntent = "edit" | "delete";

/**
 * The open category dialog (M18), or null for none. One slot rather than three
 * booleans: the three are mutually exclusive and each carries its own payload, so
 * a discriminated union makes an impossible state (renaming and deleting at once)
 * unrepresentable.
 */
export type CategoryDialog =
  | { mode: "create" }
  | { mode: "rename"; categoryId: CategoryId; name: string }
  | { mode: "delete"; categoryId: CategoryId; name: string };

/**
 * The open block confirmation (M18), or null. Carries the target's display name
 * so the confirmation can address them by name without a second fetch.
 */
export interface BlockDialogTarget {
  userId: UserId;
  displayName: string;
  /** true → this is an UNBLOCK confirmation, false → a block confirmation. */
  blocked: boolean;
}

/**
 * The open user-menu dialog (ADR 0019 + M18 moderation), or null for none.
 *
 * ONE slot holding a discriminated union rather than five booleans, for the same
 * reason as {@link CategoryDialog}: the five are mutually exclusive, each
 * carries a different payload, and "editing a note while banning" must be
 * unrepresentable. It also has to be store state rather than local state inside
 * the menu — Radix unmounts a context menu's content the instant an entry is
 * selected, so a dialog owned by the menu would be destroyed before it painted.
 *
 * `displayName` rides along so every confirmation can address the target by the
 * name the viewer actually sees (nickname-resolved by the opener) with no
 * second fetch.
 */
export type MemberDialog =
  /** Private, single-reader note about a user (ADR 0019 §1). */
  | { kind: "note"; userId: UserId; displayName: string }
  /** The viewer-only "friend nickname" — global, invisible to the target. */
  | {
      kind: "friendNickname";
      userId: UserId;
      displayName: string;
      realName: string;
      /**
       * The nickname currently in force, or null when there is none. Passed
       * explicitly rather than inferred from `displayName !== realName`, because
       * that inference cannot tell a PRIVATE nickname from a server one — and
       * getting it wrong is what hid the "Remove nickname" control.
       */
      current: string | null;
    }
  /** The per-server nickname EVERYONE in that server sees. */
  | {
      kind: "serverNickname";
      userId: UserId;
      displayName: string;
      realName: string;
      groupId: GroupId;
      current: string | null;
      /** The viewer is renaming THEMSELVES — different copy, no permission needed. */
      isSelf: boolean;
    }
  /**
   * Destructive: end the friendship. Confirmed because it is one click from
   * both the menu and a SMALL banner icon, and undoing it needs the other
   * person to accept a fresh request — you cannot take it back alone.
   */
  | { kind: "unfriend"; userId: UserId; displayName: string }
  /** Destructive: remove from the server. */
  | { kind: "kick"; userId: UserId; displayName: string; groupId: GroupId }
  /** Destructive: remove + permanently bar from rejoining. */
  | { kind: "ban"; userId: UserId; displayName: string; groupId: GroupId };

interface UiStore {
  commandMenuOpen: boolean;
  inviteDialogOpen: boolean;
  deviceDialogOpen: boolean;
  /** "Add a server" dialog (chooser / create / join — one dialog, three steps). */
  addServerDialogOpen: boolean;
  /** Which step it shows (set by whichever entry point opened it). */
  addServerStep: AddServerStep;
  /**
   * Invite code the join step should PRE-FILL (web `/invite/<kod>` route). One-shot:
   * the dialog consumes it into its input and clears it, so a later manual
   * "join" open never resurrects a stale code.
   */
  addServerPrefillCode: string | null;
  /** "Download the app" dialog (rail download button). */
  downloadDialogOpen: boolean;
  createChannelDialogOpen: boolean;
  /** Create-a-flat-group-chat dialog (home surface). */
  createGroupChatDialogOpen: boolean;
  /** Add-a-member-by-username dialog for the active flat group chat. */
  addGroupMemberDialogOpen: boolean;
  /** Server (rename/icon/delete) settings dialog. */
  serverSettingsOpen: boolean;
  /** Server the "leave server" confirmation targets (null = closed). */
  leaveServerGroupId: GroupId | null;
  /** Channel being edited in the channel-settings dialog (null = closed). */
  channelSettingsChannelId: ChannelId | null;
  /** Why the channel-settings dialog was opened (drives its initial step, task #1). */
  channelSettingsIntent: ChannelSettingsIntent;
  /**
   * Which category the create-channel dialog should file the new channel under
   * (M18). Set by the "+" on a category header; null = the uncategorized list.
   */
  createChannelCategoryId: CategoryId | null;
  /** The open create/rename/delete category dialog (M18), or null. */
  categoryDialog: CategoryDialog | null;
  /** The open block / unblock confirmation (M18), or null. */
  blockDialog: BlockDialogTarget | null;
  /** The open user-menu dialog (note / nicknames / kick / ban), or null (ADR 0019). */
  memberDialog: MemberDialog | null;
  /** Whether the "set a custom status" dialog is open (M18). */
  customStatusDialogOpen: boolean;
  /** The group chat whose invite-link dialog is open (M18), or null. */
  groupChatInviteId: GroupId | null;
  /**
   * The channel whose "invite a friend HERE" dialog is open, or null.
   *
   * A channel id rather than a boolean because the dialog's whole point is the
   * target: it names the channel in its subtitle and mints an invite carrying it,
   * so "which channel" is the state, not a detail the dialog looks up separately.
   */
  channelInviteChannelId: ChannelId | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Whether the channel message-search panel is open (Ctrl+F / header icon). */
  channelSearchOpen: boolean;
  /**
   * Server-surface center intent: when the connected voice room has live video,
   * whether the center column shows the VIDEO STAGE (`true`) or the active text
   * channel's CHAT (`false`) — voice/video keep running
   * in the background while the user reads/writes a text channel. Voice-channel
   * clicks (and the VoicePanel "return to view") set it true; text-channel clicks
   * set it false. With no live video the center is always chat, so this only
   * matters while `useHasStageVideo()` is true. Distinct from the video-stage-store's
   * per-tile `focusedKey`, which picks WHICH source is large WITHIN the stage.
   */
  stageFocused: boolean;
  /**
   * Latched true once an attachment upload is refused with ATTACHMENTS_DISABLED
   * (Supabase Storage not configured on this server, ADR 0008). The composer
   * greys out the attach button with an explanatory tooltip instead of letting
   * every pick fail. Session-scoped; reset on logout.
   */
  attachmentsDisabled: boolean;

  /**
   * True while an open settings section holds edits that have not been saved
   * (profile drafts: name/bio/birthdate/avatar/banner). Set by that section, NOT
   * by the shell. While true, `closeSettings` and `setSettingsSection` refuse to
   * act and stash the intent in {@link pendingSettingsNav} instead, so a user
   * never loses a half-typed profile to a stray Esc or backdrop click.
   */
  settingsDirty: boolean;
  /**
   * A close/navigate request that was blocked by {@link settingsDirty}. The
   * section renders the "unsaved changes" prompt off this; resolving it either
   * discards (→ `confirmSettingsNav`) or cancels (→ `cancelSettingsNav`).
   * `"close"` means "close the whole settings surface".
   */
  pendingSettingsNav: SettingsSection | "close" | null;

  setCommandMenuOpen: (open: boolean) => void;
  setInviteDialogOpen: (open: boolean) => void;
  setDeviceDialogOpen: (open: boolean) => void;
  setAddServerDialogOpen: (open: boolean) => void;
  /** Open the add-server dialog on a specific step (defaults to the chooser). */
  openAddServer: (step?: AddServerStep) => void;
  /** Move between steps while the dialog stays open (chooser ⇄ create/join). */
  setAddServerStep: (step: AddServerStep) => void;
  /** Open the dialog straight on the join step with the code pre-filled (web /kat route). */
  openJoinWithCode: (code: string) => void;
  /** Consumed by the dialog after copying the prefill into its input. */
  clearAddServerPrefill: () => void;
  setDownloadDialogOpen: (open: boolean) => void;
  /**
   * Open/close the create-channel dialog. `categoryId` pre-files the new channel
   * under a category (the "+" on a category header); omitted = uncategorized,
   * which is the pre-M18 behaviour every existing caller keeps.
   */
  setCreateChannelDialogOpen: (open: boolean, categoryId?: CategoryId | null) => void;
  setCreateGroupChatDialogOpen: (open: boolean) => void;
  setAddGroupMemberDialogOpen: (open: boolean) => void;
  setServerSettingsOpen: (open: boolean) => void;
  openLeaveServer: (groupId: GroupId) => void;
  closeLeaveServer: () => void;
  openChannelSettings: (channelId: ChannelId, intent?: ChannelSettingsIntent) => void;
  closeChannelSettings: () => void;
  /** Open one of the three category dialogs (M18); `null` closes whichever is up. */
  setCategoryDialog: (dialog: CategoryDialog | null) => void;
  /** Open the block / unblock confirmation for a user (M18); `null` closes it. */
  setBlockDialog: (target: BlockDialogTarget | null) => void;
  /** Open one of the user-menu dialogs (ADR 0019); `null` closes whichever is up. */
  setMemberDialog: (dialog: MemberDialog | null) => void;
  setCustomStatusDialogOpen: (open: boolean) => void;
  /** Open the invite-link dialog for a flat group chat (M18); `null` closes it. */
  setGroupChatInviteId: (groupChatId: GroupId | null) => void;
  /** Open (channel id) or close (null) the channel-invite dialog. */
  setChannelInviteChannelId: (channelId: ChannelId | null) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  /** Declare whether the open settings section holds unsaved edits. */
  setSettingsDirty: (dirty: boolean) => void;
  /** Discard the unsaved edits and perform the stashed close/navigate. */
  confirmSettingsNav: () => void;
  /** Dismiss the prompt and stay on the section (keep editing). */
  cancelSettingsNav: () => void;
  /** Open/close the channel search panel; `toggle` flips it (Ctrl+F). */
  setChannelSearchOpen: (open: boolean) => void;
  toggleChannelSearch: () => void;
  /** Show the voice-room video stage in the server center (voice-channel click / "return to view"). */
  showVoiceStage: () => void;
  /** Show the active text channel's chat in the server center (text-channel click). */
  showChannelChat: () => void;
  /** Latch the attachments-disabled flag (called on an ATTACHMENTS_DISABLED error). */
  markAttachmentsDisabled: () => void;
  /**
   * Reset session-scoped UI chrome for an account switch / logout (ADR 0013
   * storeReset): clears the per-server `attachmentsDisabled` latch and closes any
   * open transient dialogs so the next account never inherits the previous one's
   * "attachments off" state or a half-open server/channel dialog. Persisted
   * appearance/settings-section prefs are left alone.
   */
  resetForAccountSwitch: () => void;
}

export const useUiStore = create<UiStore>()((set, get) => ({
  commandMenuOpen: false,
  inviteDialogOpen: false,
  deviceDialogOpen: false,
  addServerDialogOpen: false,
  addServerStep: "choose",
  addServerPrefillCode: null,
  downloadDialogOpen: false,
  createChannelDialogOpen: false,
  createGroupChatDialogOpen: false,
  addGroupMemberDialogOpen: false,
  serverSettingsOpen: false,
  leaveServerGroupId: null,
  channelSettingsChannelId: null,
  channelSettingsIntent: "edit",
  createChannelCategoryId: null,
  categoryDialog: null,
  blockDialog: null,
  memberDialog: null,
  customStatusDialogOpen: false,
  groupChatInviteId: null,
  channelInviteChannelId: null,
  settingsOpen: false,
  settingsSection: "profile",
  settingsDirty: false,
  pendingSettingsNav: null,
  channelSearchOpen: false,
  // Default to the stage so the first live video in a session takes over the
  // center as before; any text-channel click flips it to chat (never trapped).
  stageFocused: true,
  attachmentsDisabled: false,

  setCommandMenuOpen: (open) => set({ commandMenuOpen: open }),
  setInviteDialogOpen: (open) => set({ inviteDialogOpen: open }),
  setDeviceDialogOpen: (open) => set({ deviceDialogOpen: open }),
  setAddServerDialogOpen: (open) => set({ addServerDialogOpen: open }),
  openAddServer: (step = "choose") => set({ addServerDialogOpen: true, addServerStep: step }),
  setAddServerStep: (step) => set({ addServerStep: step }),
  openJoinWithCode: (code) =>
    set({ addServerDialogOpen: true, addServerStep: "join", addServerPrefillCode: code }),
  clearAddServerPrefill: () => set({ addServerPrefillCode: null }),
  setDownloadDialogOpen: (open) => set({ downloadDialogOpen: open }),
  setCreateChannelDialogOpen: (open, categoryId = null) =>
    // Always rewrite the target category, including on close, so the next plain
    // "create channel" can never inherit the last category header's "+".
    set({ createChannelDialogOpen: open, createChannelCategoryId: open ? categoryId : null }),
  setCreateGroupChatDialogOpen: (open) => set({ createGroupChatDialogOpen: open }),
  setAddGroupMemberDialogOpen: (open) => set({ addGroupMemberDialogOpen: open }),
  setServerSettingsOpen: (open) => set({ serverSettingsOpen: open }),
  openLeaveServer: (groupId) => set({ leaveServerGroupId: groupId }),
  closeLeaveServer: () => set({ leaveServerGroupId: null }),
  openChannelSettings: (channelId, intent = "edit") =>
    set({ channelSettingsChannelId: channelId, channelSettingsIntent: intent }),
  closeChannelSettings: () => set({ channelSettingsChannelId: null, channelSettingsIntent: "edit" }),
  setCategoryDialog: (dialog) => set({ categoryDialog: dialog }),
  setBlockDialog: (target) => set({ blockDialog: target }),
  setMemberDialog: (dialog) => set({ memberDialog: dialog }),
  setCustomStatusDialogOpen: (open) => set({ customStatusDialogOpen: open }),
  setGroupChatInviteId: (groupChatId) => set({ groupChatInviteId: groupChatId }),
  setChannelInviteChannelId: (channelId) => set({ channelInviteChannelId: channelId }),
  openSettings: (section) =>
    set((state) => ({
      settingsOpen: true,
      settingsSection: section ?? state.settingsSection,
    })),
  // Both of these are GUARDED: with unsaved profile edits open they park the
  // intent and let the section prompt instead of silently dropping the draft.
  closeSettings: () => {
    if (get().settingsDirty) {
      set({ pendingSettingsNav: "close" });
      return;
    }
    set({ settingsOpen: false, pendingSettingsNav: null });
  },
  setSettingsSection: (section) => {
    if (get().settingsDirty && get().settingsSection !== section) {
      set({ pendingSettingsNav: section });
      return;
    }
    set({ settingsSection: section });
  },
  setSettingsDirty: (dirty) =>
    // Dropping the dirty flag also drops any parked prompt — the section just
    // saved or reset, so there is nothing left to warn about.
    set(dirty ? { settingsDirty: true } : { settingsDirty: false, pendingSettingsNav: null }),
  confirmSettingsNav: () => {
    const target = get().pendingSettingsNav;
    if (!target) return;
    // Clear dirty FIRST so the guarded actions below let the intent through.
    set({ settingsDirty: false, pendingSettingsNav: null });
    if (target === "close") set({ settingsOpen: false });
    else set({ settingsSection: target });
  },
  cancelSettingsNav: () => set({ pendingSettingsNav: null }),
  setChannelSearchOpen: (open) => set({ channelSearchOpen: open }),
  toggleChannelSearch: () => set((state) => ({ channelSearchOpen: !state.channelSearchOpen })),
  showVoiceStage: () => {
    if (!get().stageFocused) set({ stageFocused: true });
  },
  showChannelChat: () => {
    if (get().stageFocused) set({ stageFocused: false });
  },
  markAttachmentsDisabled: () => {
    if (!get().attachmentsDisabled) set({ attachmentsDisabled: true });
  },
  resetForAccountSwitch: () =>
    set({
      attachmentsDisabled: false,
      // Close transient dialogs/panels that reference the departing account's data.
      inviteDialogOpen: false,
      addServerDialogOpen: false,
      addServerStep: "choose",
      addServerPrefillCode: null,
      downloadDialogOpen: false,
      createChannelDialogOpen: false,
      createChannelCategoryId: null,
      createGroupChatDialogOpen: false,
      addGroupMemberDialogOpen: false,
      serverSettingsOpen: false,
      leaveServerGroupId: null,
      channelSettingsChannelId: null,
      channelSearchOpen: false,
      // M18 dialogs all name a category / user / group of the DEPARTING account —
      // leaving any of them open would target a row the next account cannot see.
      categoryDialog: null,
      blockDialog: null,
      memberDialog: null,
      customStatusDialogOpen: false,
      groupChatInviteId: null,
      channelInviteChannelId: null,
      // The departing account's unsaved profile draft must not block the next
      // account's settings (it would park every close behind a stale prompt).
      settingsDirty: false,
      pendingSettingsNav: null,
    }),
}));
