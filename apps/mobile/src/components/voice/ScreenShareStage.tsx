import { useMemo, useState } from "react";
import type { ViewStyle } from "react-native";
import { ScrollView, View } from "react-native";
import { Eye, EyeOff } from "lucide-react-native";
import { pickSpeakingSubject, type RemoteScreenShare } from "@demli/media";
import { useAppTranslation } from "@/lib/i18n";
import { colors, space } from "@/theme/theme";
import { Chip } from "../ui/Chip";
import { useActiveSpeakers } from "./active-speakers";
import { ParticipantTile, type ParticipantTileData } from "./ParticipantTile";
import type { PipSubject } from "./VideoFullscreenModal";
import { ScreenShareView } from "./ScreenShareView";

/**
 * The screen-share focus view (default stage when a host is sharing). The share
 * fills the stage; ALL other participants — cameras AND cameraless avatars —
 * ride a single equal-sized horizontal filmstrip beneath it (never a ragged mix
 * of camera boxes and tiny chips).
 *
 * Requirement #3 — collapse cameras while watching: a toggle hides/shows the
 * whole filmstrip so the tiles never crowd the stream. Requirement #68 — the
 * ACTIVE SPEAKER (or, when quiet, the sharer) is forwarded to
 * {@link ScreenShareView} as `pipSubject`, so the fullscreen viewer can pin them
 * as a movable PiP over the stream and the watcher always sees who is talking.
 *
 * Fullscreen is CONTROLLED from above (VoiceRoomScreen owns the state so it can
 * force LANDSCAPE only while a share is fullscreen, founder #70); we just pass it
 * straight through.
 *
 * Purely presentational + local collapse state; every tile renders the live
 * track object the engine already surfaced (no new subscription).
 */
export function ScreenShareStage({
  share,
  sharerName,
  participantTiles,
  fullscreen,
  onFullscreenChange,
}: {
  share: RemoteScreenShare;
  sharerName: string | null;
  participantTiles: ParticipantTileData[];
  fullscreen: boolean;
  onFullscreenChange: (open: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const speakers = useActiveSpeakers();
  const [collapsed, setCollapsed] = useState(false);
  // Stable filmstrip tile size so a speaking tick doesn't churn the memoized tiles (§27).
  const stripStyle = useMemo<ViewStyle>(() => ({ width: 128, aspectRatio: 4 / 3 }), []);

  const hasStrip = participantTiles.length > 0;

  // PiP subject (#68): follow the active speaker, else fall back to the sharer;
  // NEVER show yourself. Carries the person's camera track when they have one on,
  // else null so the PiP renders their avatar instead of a black box.
  //
  // "Who is talking" comes from the ONE shared `ActiveSpeakerTracker`
  // (`@demli/media`), the same source the OS-PiP window uses — so the two
  // surfaces can never disagree. It also fixes what the old
  // `others.find(tile => tile.speaking)` did: `speaking` is momentary, so every
  // pause between sentences dropped the subject back to the sharer. The tracker
  // holds a talker across gaps (5 s release) and remembers the last one, so the
  // PiP tracks the conversation instead of flickering.
  const pipSubject = useMemo<PipSubject | null>(() => {
    const others = participantTiles.filter((tile) => !tile.isLocal);
    if (others.length === 0) return null;
    const subject =
      pickSpeakingSubject(others, speakers) ??
      others.find((tile) => tile.userId === share.userId) ??
      null;
    if (!subject) return null;
    return {
      identity: subject.identity,
      userId: subject.userId,
      track: subject.track,
      name: subject.name,
      avatarUrl: subject.avatarUrl,
      speaking: subject.speaking,
    };
  }, [participantTiles, share.userId, speakers]);

  // Camera subjects for the fullscreen viewer (founder #2): non-local participants
  // whose camera is ON. With 2+ the fullscreen viewer shows a RIGHT camera STRIP
  // (a docked panel) instead of floating; with 0–1 it keeps the single
  // draggable active-speaker PiP. Cameraless people stay off the strip (they ride
  // the bottom filmstrip below the stage), so the strip is never a wall of avatars.
  const cameraSubjects = useMemo<PipSubject[]>(
    () =>
      participantTiles
        .filter((tile) => !tile.isLocal && tile.track)
        .map((tile) => ({
          identity: tile.identity,
          userId: tile.userId,
          track: tile.track,
          name: tile.name,
          avatarUrl: tile.avatarUrl,
          speaking: tile.speaking,
        })),
    [participantTiles],
  );

  return (
    <View style={{ flex: 1, padding: space.md, gap: space.md }}>
      <ScreenShareView
        share={share}
        sharerName={sharerName}
        pipSubject={pipSubject}
        cameraSubjects={cameraSubjects}
        fullscreen={fullscreen}
        onFullscreenChange={onFullscreenChange}
      />

      {hasStrip ? (
        <View style={{ gap: space.sm }}>
          <Chip
            onPress={() => setCollapsed((v) => !v)}
            leading={
              collapsed ? (
                <Eye size={15} color={colors.fgMuted} strokeWidth={2} />
              ) : (
                <EyeOff size={15} color={colors.fgMuted} strokeWidth={2} />
              )
            }
            label={
              collapsed
                ? t("mobile:voice.showCamerasCount", { n: participantTiles.length })
                : t("mobile:voice.hideCameras")
            }
          />

          {!collapsed ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: space.md, paddingHorizontal: space.xs, alignItems: "center" }}
            >
              {participantTiles.map((tile) => (
                <ParticipantTile
                  key={tile.identity}
                  identity={tile.identity}
                  userId={tile.userId}
                  track={tile.track}
                  name={tile.name}
                  avatarUrl={tile.avatarUrl}
                  isLocal={tile.isLocal}
                  muted={tile.muted}
                  speaking={tile.speaking}
                  style={stripStyle}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
