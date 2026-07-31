/**
 * YOUR OWN camera as the floating overlay while another tile owns the stage —
 * the mobile half of the K4 self-view contract
 * (`docs/decisions/0022-call-video-experience.md`), matching desktop's
 * `CameraPip` self-view.
 *
 * The contract, identical on both platforms:
 *  - Shown in FOCUS and FULLSCREEN, where your own tile is off the stage. In GRID
 *    you are already a normal tile, so a second copy of your face would just be
 *    noise (K4's rejected alternative).
 *  - Bottom-right by default, draggable, and the corner is REMEMBERED
 *    (`self-view-store`).
 *  - Default ON, dismissable — and when your camera is OFF the box does NOT
 *    vanish, it becomes an explicit "camera off" rectangle. That is the founder's
 *    requirement stated directly ("kameramın açık olmadığını anlayayım") and the
 *    honest design: absence would be indistinguishable from a bug (§35).
 *
 * It renders the SAME live track object the grid/stage already hold, through the
 * same {@link DraggableCameraPip} the active-speaker overlay uses — one drag
 * layer, one video attach, no second subscription and no second floating box
 * (founder: "iki ayrı sürüklenebilir kutu yapma").
 */
import type { EdgeInsets } from "react-native-safe-area-context";
import { useAppTranslation } from "@/lib/i18n";
import { useSelfViewStore } from "@/stores/self-view-store";
import { DraggableCameraPip } from "./DraggableCameraPip";
import type { ParticipantTileData } from "./ParticipantTile";

export function SelfViewPip({
  self,
  width,
  height,
  insets,
}: {
  /** Your own stage tile, or null when the roster has not populated yet. */
  self: ParticipantTileData | null;
  /** Container width the overlay is clamped within. */
  width: number;
  /** Container height the overlay is clamped within. */
  height: number;
  insets: EdgeInsets;
}) {
  const { t } = useAppTranslation();
  const enabled = useSelfViewStore((s) => s.enabled);
  const corner = useSelfViewStore((s) => s.corner);
  const setCorner = useSelfViewStore((s) => s.setCorner);
  const setEnabled = useSelfViewStore((s) => s.setEnabled);

  if (!enabled || !self) return null;

  return (
    <DraggableCameraPip
      track={self.track}
      userId={self.userId}
      name={t("mobile:voice.selfView.label")}
      avatarUrl={self.avatarUrl}
      speaking={self.speaking}
      // Camera off → the explicit placeholder rectangle, never an empty gap.
      cameraOff
      // Your own camera reads as a mirror, exactly as the self-preview tile does.
      mirror
      corner={corner}
      onCornerChange={setCorner}
      onClose={() => setEnabled(false)}
      closeLabel={t("mobile:voice.selfView.hide")}
      width={width}
      height={height}
      insets={insets}
    />
  );
}
