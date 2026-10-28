-- Voice messages (M19): distinguish inline-recorded audio from file-picked audio.
-- A voice message renders as a compact waveform bubble; a file attachment keeps
-- the current audio-player card. Default FALSE so every pre-0025 audio row is
-- unaffected.
ALTER TABLE "attachments" ADD COLUMN "is_voice_message" boolean NOT NULL DEFAULT false;
