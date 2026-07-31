import { useMemo } from "react";
import type { VideoTrackProps } from "@livekit/react-native";

/** The minimal `TrackReference` `@livekit/react-native`'s `<VideoTrack>` consumes. */
export type VideoTrackRef = NonNullable<VideoTrackProps["trackRef"]>;

/**
 * Build the minimal `TrackReference` `<VideoTrack>` actually reads
 * (`publication.track` + `publication.trackSid`) from a bare livekit track.
 *
 * The engine (`@demli/media`) surfaces every video source — remote camera,
 * remote screen share, local camera — as a bare track object with no publication
 * wrapper (that shape targets the web's `attach(HTMLMediaElement)` path). RN's
 * `<VideoTrack>` instead wants a `TrackReference`, so we adapt UI-side from the
 * track we DO have. This does NOT open a subscription — the underlying track is
 * the engine's single live track; any number of `<VideoTrack>`s can attach to it
 * (tile + fullscreen + PiP all reuse the one track). `@demli/media` stays
 * untouched. Keeping this in one helper means every surface builds the exact same
 * reference shape (no divergence between tile, stage, fullscreen, and PiP).
 */
export function toVideoTrackRef(track: object): VideoTrackRef {
  return {
    publication: {
      track,
      trackSid: (track as { sid?: string }).sid,
    },
  } as unknown as VideoTrackRef;
}

/** Memoized {@link toVideoTrackRef}, rebuilt only when the underlying track swaps. */
export function useVideoTrackRef(track: object): VideoTrackRef {
  return useMemo(() => toVideoTrackRef(track), [track]);
}
