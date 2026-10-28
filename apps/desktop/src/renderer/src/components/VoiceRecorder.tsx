import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Send, X } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { api } from "../lib/api-client";
import { sendChatMessage } from "../realtime/connection";

type RecorderState = "idle" | "recording" | "uploading";

function formatTimer(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const MIME = "audio/ogg;codecs=opus";
const BAR_COUNT = 24;

export function VoiceRecorder({
  channelId,
  disabled,
}: {
  channelId: string;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [bars, setBars] = useState<number[]>(() => new Array(BAR_COUNT).fill(4));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef(0);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setElapsed(0);
    setBars(new Array(BAR_COUNT).fill(4));
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const recorder = new MediaRecorder(stream, { mimeType: MIME });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(100);
      startTimeRef.current = Date.now();
      setState("recording");

      timerRef.current = window.setInterval(() => {
        setElapsed(Date.now() - startTimeRef.current);
      }, 200);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = (): void => {
        analyser.getByteFrequencyData(dataArray);
        const newBars: number[] = [];
        const step = Math.floor(dataArray.length / BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i++) {
          const val = dataArray[i * step] ?? 0;
          newBars.push(4 + (val / 255) * 20);
        }
        setBars(newBars);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
    } catch {
      cleanup();
      setState("idle");
    }
  }, [cleanup]);

  const cancel = useCallback(() => {
    mediaRecorderRef.current?.stop();
    cleanup();
    setState("idle");
  }, [cleanup]);

  const send = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    setState("uploading");
    const durationMs = Date.now() - startTimeRef.current;

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    const blob = new Blob(chunksRef.current, { type: MIME });
    cleanup();

    try {
      const ticket = await api.createAttachmentUploadUrl(channelId, {
        mime: "audio/ogg",
        sizeBytes: blob.size,
        isVoiceMessage: true,
      });

      await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "audio/ogg" },
        body: blob,
      });

      const { attachment } = await api.completeAttachment(ticket.attachmentId, { durationMs });

      sendChatMessage(channelId, "", {
        attachmentIds: [attachment.id],
        attachments: [attachment],
        localAttachmentUrls: {},
      });
    } catch {
      // Upload failed — silently drop (the user can try again).
    }
    setState("idle");
  }, [channelId, cleanup]);

  if (state === "idle") {
    return (
      <div className="flex h-11 shrink-0 items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("common:voice.recordStart")}
                disabled={disabled}
                className="text-fg-faint"
                onClick={startRecording}
              >
                <Mic className="size-5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t("common:voice.recordStart")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (state === "uploading") {
    return (
      <div className="flex h-11 items-center px-2">
        <div className="h-1.5 w-20 animate-pulse rounded-full bg-accent/30" />
      </div>
    );
  }

  return (
    <div className="flex h-11 flex-1 items-center gap-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("common:voice.cancel")}
        className="shrink-0 text-danger"
        onClick={cancel}
      >
        <X className="size-4" />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
        <span className="shrink-0 text-xs font-medium tabular-nums text-fg-muted">
          {formatTimer(elapsed)}
        </span>
        <div className="flex flex-1 items-center justify-center gap-px" aria-hidden>
          {bars.map((h, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-accent transition-[height] duration-100"
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("common:voice.voiceMessage")}
        className="shrink-0 text-accent"
        onClick={send}
      >
        <Send className="size-4" />
      </Button>
    </div>
  );
}
