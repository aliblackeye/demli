/**
 * A pipeline failure that already carries its localized catalog key
 * (ADR 0009). The upload pipeline (validate/process/upload) is React-free, so
 * it can't localize its own failures; it throws this instead of a frozen
 * English `Error`, and the manager reads `draftError` onto the draft for the
 * tray to resolve at render (the desktop DraftError pattern).
 */

import type { DraftError } from "../errors";

export class AttachmentPipelineError extends Error {
  readonly draftError: DraftError;

  constructor(draftError: DraftError) {
    // The message is dev-only; the tray renders the resolved catalog key.
    super(draftError.key);
    this.name = "AttachmentPipelineError";
    this.draftError = draftError;
  }
}
