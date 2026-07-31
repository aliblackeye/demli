/**
 * Composer attachment drafts (ADR 0008 §5) — the pending-attachment tray state.
 * Mobile mirror of the desktop renderer's stores/attachment-store.ts.
 *
 * Drafts are keyed per channel so switching screens never loses an in-flight
 * upload. This store holds only render-safe metadata (status/progress/local
 * file URI); the upload task handles live in the upload manager's module maps
 * (CLAUDE.md §27 — no media bytes in React state). All mutations flow through
 * lib/attachments/manager.ts.
 */

import { create } from "zustand";
import type { Attachment, AttachmentKind, ChannelId } from "@demli/types";
import type { DraftError } from "../lib/errors";

export type DraftStatus = "processing" | "uploading" | "ready" | "error";

export interface DraftAttachment {
  /** Client-local key — stable across retries. */
  localId: string;
  channelId: ChannelId;
  /** Original filename, display-only. */
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** Final (post-processing) byte size. */
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /**
   * Local file URI of the upload-ready bytes (post-processing for images).
   * Doubles as the tray thumbnail source and, once sent, the sender's own
   * render URL (registered with the signed-URL resolver).
   */
  localUri: string | null;
  status: DraftStatus;
  /** Upload fraction 0..1 (only meaningful while uploading). */
  progress: number;
  /** The server attachment once `complete` succeeded (status "ready"). */
  attachment: Attachment | null;
  /**
   * Failure as a catalog KEY (+ params), localized by the tray at render
   * (status "error"). Never a frozen string, so a live locale switch
   * re-translates it.
   */
  error: DraftError | null;
}

interface AttachmentStore {
  drafts: Record<ChannelId, DraftAttachment[]>;

  addDraft: (draft: DraftAttachment) => void;
  updateDraft: (channelId: ChannelId, localId: string, patch: Partial<DraftAttachment>) => void;
  removeDraft: (channelId: ChannelId, localId: string) => void;
  /** Remove and return the ready drafts of a channel (called on send). */
  takeReadyDrafts: (channelId: ChannelId) => DraftAttachment[];
  /** Full reset on logout. */
  resetAttachmentDrafts: () => void;
}

export const useAttachmentStore = create<AttachmentStore>()((set, get) => ({
  drafts: {},

  addDraft: (draft) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [draft.channelId]: [...(state.drafts[draft.channelId] ?? []), draft],
      },
    })),

  updateDraft: (channelId, localId, patch) => {
    const list = get().drafts[channelId];
    if (!list?.some((d) => d.localId === localId)) return;
    set((state) => ({
      drafts: {
        ...state.drafts,
        [channelId]: (state.drafts[channelId] ?? []).map((d) =>
          d.localId === localId ? { ...d, ...patch } : d,
        ),
      },
    }));
  },

  removeDraft: (channelId, localId) => {
    const list = get().drafts[channelId];
    if (!list?.some((d) => d.localId === localId)) return;
    set((state) => ({
      drafts: {
        ...state.drafts,
        [channelId]: (state.drafts[channelId] ?? []).filter((d) => d.localId !== localId),
      },
    }));
  },

  takeReadyDrafts: (channelId) => {
    const list = get().drafts[channelId] ?? [];
    const ready = list.filter((d) => d.status === "ready" && d.attachment !== null);
    if (ready.length === 0) return [];
    set((state) => ({
      drafts: {
        ...state.drafts,
        [channelId]: (state.drafts[channelId] ?? []).filter((d) => d.status !== "ready"),
      },
    }));
    return ready;
  },

  resetAttachmentDrafts: () => set({ drafts: {} }),
}));
