/**
 * Voice message recorder — inline replacement for the send button when the
 * composer text is empty. Tap the mic to start recording, then send or cancel.
 *
 * Recording uses expo-audio's `useAudioRecorder` with AAC on Android/iOS
 * (the only cross-platform codec expo-audio supports cleanly).
 *
 * Upload flow mirrors the attachment manager but is self-contained here:
 *   record → stop → createAttachmentUploadUrl(isVoiceMessage) →
 *   PUT file → completeAttachment(durationMs) → sendChatMessage
 */

import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import {
  useAudioRecorder,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type RecordingOptions,
  AudioQuality,
  IOSOutputFormat,
} from "expo-audio";
import { ArrowUp, Mic, X } from "lucide-react-native";
import type { ChannelId, MessageReplyPreview } from "@demli/types";
import { getApi } from "../lib/clients";
import { sendChatMessage } from "../realtime/connection";
import { attachmentUrlResolver } from "../lib/attachments/url-resolver";
import { useAppTranslation } from "../lib/i18n";
import { haptics } from "../lib/haptics";
import { toast } from "./ui/Toast";
import { IconButton } from "./ui/IconButton";
import { Text } from "./ui/Text";
import { colors, radius, space } from "../theme/theme";

/**
 * Recording preset: AAC in MP4 container on both platforms. Mono, 64kbps —
 * compact enough for voice; the server stores it as-is.
 */
const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: {
    extension: ".m4a",
    sampleRate: 44100,
    outputFormat: "mpeg4",
    audioEncoder: "aac",
  },
  ios: {
    extension: ".m4a",
    sampleRate: 44100,
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

const VOICE_MIME = "audio/mp4";

function formatTimer(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface VoiceRecorderProps {
  channelId: ChannelId;
  /** Active reply draft to thread onto the sent voice message. */
  replyTo?: MessageReplyPreview;
  onSent: () => void;
}

/**
 * Hook that drives the voice recorder. Returns state + callbacks for the
 * Composer to render the mic button or the recording strip.
 */
export function useVoiceRecorder(props: VoiceRecorderProps) {
  const { channelId, replyTo, onSent } = props;
  const { t } = useAppTranslation();
  const [recording, setRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [sending, setSending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);

  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);

  // Cleanup timer on unmount / channel switch.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [channelId]);

  const startRecording = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        toast({ title: t("common:voice.recordStart"), description: "Permission denied", variant: "danger" });
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      recorder.record();
      startTimeRef.current = Date.now();
      setDurationMs(0);
      setRecording(true);
      haptics.light();
      timerRef.current = setInterval(() => {
        setDurationMs(Date.now() - startTimeRef.current);
      }, 200);
    } catch {
      toast({ title: t("common:voice.recordStart"), description: "Failed to start", variant: "danger" });
    }
  };

  const cancelRecording = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRecording(false);
    setDurationMs(0);
    try {
      await recorder.stop();
    } catch {
      // already stopped
    }
  };

  const sendRecording = async () => {
    if (sending) return;
    setSending(true);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const finalDuration = Date.now() - startTimeRef.current;
    setRecording(false);

    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("No recording URI");

      const actualDuration = Math.round(recorder.currentTime * 1000) || finalDuration;

      // Read file size via fetch (expo-audio recordings are local file URIs).
      const blob = await fetch(uri).then((r) => r.blob());
      const sizeBytes = blob.size;

      const ticket = await getApi().createAttachmentUploadUrl(channelId, {
        mime: VOICE_MIME,
        sizeBytes,
        isVoiceMessage: true,
      });

      // PUT raw bytes to the signed URL.
      await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": VOICE_MIME },
        body: blob,
      });

      const { attachment } = await getApi().completeAttachment(ticket.attachmentId, {
        durationMs: actualDuration,
      });

      // Let the sender's own tile render from the local file immediately.
      attachmentUrlResolver.setLocalUrl(attachment.id, uri);

      sendChatMessage(channelId, "", [attachment], replyTo);
      onSent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast({ title: t("common:voice.voiceMessage"), description: msg, variant: "danger" });
    } finally {
      setSending(false);
      setDurationMs(0);
    }
  };

  return { recording, durationMs, sending, startRecording, cancelRecording, sendRecording };
}

/** The mic button shown in the composer when text is empty. */
export function MicButton({ onPress }: { onPress: () => void }) {
  const { t } = useAppTranslation();
  return (
    <IconButton
      icon={Mic}
      label={t("common:voice.recordStart")}
      variant="secondary"
      size="lg"
      haptic="light"
      onPress={onPress}
    />
  );
}

/** The recording strip: red dot + timer + cancel + send. */
export function RecordingStrip({
  durationMs,
  sending,
  onCancel,
  onSend,
}: {
  durationMs: number;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        height: 48,
        paddingHorizontal: space.md,
        borderRadius: radius.cta,
        borderCurve: "continuous",
        backgroundColor: colors.surfaceRaised,
      }}
    >
      {/* Red recording dot */}
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: colors.danger,
        }}
      />
      <Text
        type="ui"
        tone="default"
        style={{ flex: 1, fontVariant: ["tabular-nums"], fontWeight: "600" }}
      >
        {formatTimer(durationMs)}
      </Text>
      <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
        {t("common:voice.recording")}
      </Text>
      <IconButton icon={X} label={t("common:voice.cancel")} size="sm" onPress={onCancel} />
      <IconButton
        icon={ArrowUp}
        label={t("mobile:composer.send")}
        variant="accent"
        size="md"
        disabled={sending}
        onPress={onSend}
      />
    </View>
  );
}
