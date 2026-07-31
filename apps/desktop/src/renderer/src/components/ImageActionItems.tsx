import { ContextMenuItem } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import {
  canCopyImage,
  canSaveImage,
  copyImage,
  saveImage,
  type ImageActionTarget,
} from "../lib/image-actions";

/**
 * The two entries every image surface offers: "save image" (a real save-as, the
 * user picks the folder) and "copy image" (the picture itself on the clipboard,
 * so it pastes into Word/Paint/another chat — not a URL, not a path).
 *
 * Rendered inside an {@link ActionMenu}, which gives right-click on a mouse AND
 * a long-press on touch, so the narrow/web surface is never locked out.
 *
 * "Copy image" is OMITTED, not disabled, when the surface cannot put an image on
 * the clipboard (older Safari/Firefox on the web build) — a dead button is worse
 * than no button (CLAUDE.md §35).
 */
export function ImageActionItems({ target }: { target: ImageActionTarget }): JSX.Element | null {
  const { t } = useAppTranslation();
  const canSave = canSaveImage();
  const canCopy = canCopyImage();
  if (!canSave && !canCopy) return null;

  return (
    <>
      {canSave && (
        <ContextMenuItem onSelect={() => void saveImage(target)}>
          {t("desktop:attachments.saveImage")}
        </ContextMenuItem>
      )}
      {canCopy && (
        <ContextMenuItem onSelect={() => void copyImage(target)}>
          {t("desktop:attachments.copyImage")}
        </ContextMenuItem>
      )}
    </>
  );
}

/** True when at least one image action is available on this surface. */
export function hasImageActions(): boolean {
  return canSaveImage() || canCopyImage();
}
