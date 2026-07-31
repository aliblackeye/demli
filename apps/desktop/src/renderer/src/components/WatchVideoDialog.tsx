/**
 * The renderer's wiring around {@link WatchVideoPicker} (M20 wave 3).
 *
 * The picker itself is presentational and lives in `packages/app-ui`, so it can
 * be mounted by a DOM test and, later, by the web client. This wrapper is the
 * desktop-only half: it asks the server what it can do, owns the search state
 * machine (and with it the quota discipline — see `queries/watch-queries.ts`),
 * and hands the chosen video to the caller.
 *
 * Three callers, one dialog: START a party, CHANGE its video, ADD to its queue.
 * They differ only in the verb and in which frame the submit handler sends, and
 * keeping them on one component is why "search for a video" works identically in
 * all three — including for the FIRST video, which is the moment the founder's
 * "let me pick from inside the app" request is actually about.
 */

import { WatchVideoPicker, type WatchPickerMode } from "@demli/app-ui";
import type { ChannelId } from "@demli/types";
import { useWatchSearchEnabled, useWatchVideoSearch } from "../queries/watch-queries";

export interface WatchVideoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: WatchPickerMode;
  /** The voice channel the search is scoped to (the API checks visibility). */
  channelId: ChannelId | null;
  /** The chosen video. `videoRef` is raw — the server normalizes it. */
  onSubmit: (input: {
    videoRef: string;
    title?: string;
    durationSeconds?: number;
  }) => void;
}

export function WatchVideoDialog({
  open,
  onOpenChange,
  mode,
  channelId,
  onSubmit,
}: WatchVideoDialogProps): JSX.Element {
  // Only asked while the dialog is open: a capabilities read is cheap, but there
  // is no reason for every voice channel view to make one.
  const searchEnabled = useWatchSearchEnabled(open);
  const { state, run, reset } = useWatchVideoSearch(channelId);

  return (
    <WatchVideoPicker
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      searchEnabled={searchEnabled}
      search={state}
      onSearch={run}
      onResetSearch={reset}
      onSubmit={onSubmit}
    />
  );
}
