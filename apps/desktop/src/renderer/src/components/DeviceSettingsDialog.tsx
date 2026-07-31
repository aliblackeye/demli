import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useUiStore } from "../stores/ui-store";
import { DeviceSettingsForm } from "./DeviceSettingsForm";

export function DeviceSettingsDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.deviceDialogOpen);
  const setOpen = useUiStore((s) => s.setDeviceDialogOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("desktop:voice.voiceSettings")}</DialogTitle>
          <DialogDescription>{t("desktop:devices.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <DeviceSettingsForm />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
