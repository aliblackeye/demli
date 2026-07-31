import { Copy, Download, X } from "lucide-react";
import { Dialog, DialogBareContent, DialogClose, DialogTitle, cn } from "@demli/ui";
import { ActionMenu } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import {
  canCopyImage,
  canSaveImage,
  copyImage,
  saveImage,
  type ImageActionTarget,
} from "../lib/image-actions";
import { ImageActionItems } from "./ImageActionItems";

/** Shared look for the controls floating over the dimmed backdrop. */
const OVERLAY_BUTTON_CLASS = cn(
  "cursor-pointer rounded-lg bg-black/50 p-2 text-white/80 transition-colors motion-instant",
  "hover:bg-black/70 hover:text-white",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
);

/**
 * Full-viewport image viewer. Radix Dialog gives focus-trapping, Esc-to-close
 * and aria wiring; the image URL is the already-resolved signed URL from the
 * tile that opened it (no extra fetch). Clicking the dimmed backdrop, the close
 * button, or pressing Esc closes it.
 *
 * When `actions` is present the enlarged view also carries VISIBLE save/copy
 * buttons next to the close control, and the picture itself keeps the same
 * right-click / long-press menu as the tile. The buttons matter: at this size
 * the image is the whole screen, and a hidden context menu would be the only way
 * to act on it — including on touch, where there is no right-click at all.
 */
export function ImageLightbox({
  open,
  onOpenChange,
  url,
  alt,
  actions = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
  alt: string;
  actions?: ImageActionTarget | null;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  if (!url) return null;

  const showSave = actions !== null && canSaveImage();
  const showCopy = actions !== null && canCopyImage();
  // Without this the right-click wrapper would still open an EMPTY popup on a
  // surface where neither action is available (same gate AttachmentTile uses).
  const showMenu = actions !== null && (showSave || showCopy);

  const image = (
    <img
      src={url}
      alt={alt}
      className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBareContent
        className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-12 animate-fade-in"
        onClick={(event) => {
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
      >
        <div className="absolute inset-0 -z-10 bg-black/85" aria-hidden />
        <DialogTitle className="sr-only">
          {alt || t("desktop:attachments.imagePreview")}
        </DialogTitle>
        {showMenu && actions ? (
          <ActionMenu contentClassName="w-52" menu={<ImageActionItems target={actions} />}>
            <div className="flex max-h-full max-w-full">{image}</div>
          </ActionMenu>
        ) : (
          image
        )}
        <div className="absolute right-4 top-4 flex items-center gap-2">
          {showSave && actions && (
            <OverlayButton
              label={t("desktop:attachments.saveImage")}
              onClick={() => void saveImage(actions)}
            >
              <Download className="size-5" />
            </OverlayButton>
          )}
          {showCopy && actions && (
            <OverlayButton
              label={t("desktop:attachments.copyImage")}
              onClick={() => void copyImage(actions)}
            >
              <Copy className="size-5" />
            </OverlayButton>
          )}
          <DialogClose aria-label={t("buttons.close")} className={OVERLAY_BUTTON_CLASS}>
            <X className="size-5" />
          </DialogClose>
        </div>
      </DialogBareContent>
    </Dialog>
  );
}

function OverlayButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={OVERLAY_BUTTON_CLASS}
    >
      {children}
    </button>
  );
}
