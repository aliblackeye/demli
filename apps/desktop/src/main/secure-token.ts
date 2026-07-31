import {
  app,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SECURE_TOKEN_CHANNELS } from "./secure-token-types";

/**
 * Secure session-token store (main process).
 *
 * Closes security-review finding M1: the desktop session token used to live in
 * renderer `localStorage`, readable by any renderer-context script (an XSS would
 * steal a long-lived bearer token). It now lives here in the main process,
 * encrypted with the OS keystore via Electron `safeStorage` and persisted to a
 * file under `app.getPath('userData')`. The renderer reaches it only through the
 * validated preload bridge (`window.demli.secureToken`) — never directly.
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - The token is encrypted with `safeStorage.encryptString` before it ever
 *     touches disk; only ciphertext is written.
 *   - FAIL SAFE: if `safeStorage.isEncryptionAvailable()` is false (rare on
 *     Windows), we do NOT fall back to plaintext-on-disk. `set` no-ops (logs a
 *     warning) and `get` returns null, so a token is never written unencrypted.
 *   - Every `set` payload is zod-validated (non-empty string, bounded length)
 *     before use, mirroring the capture IPC handlers.
 *   - The session file is written atomically (tmp + rename) with 0600 perms so a
 *     torn write can't leave a corrupt/partial ciphertext in place.
 */

// ---------------------------------------------------------------------------
// Limits & storage location
// ---------------------------------------------------------------------------

/** Ciphertext file name under the app's userData directory. */
const SESSION_FILE = "session.bin";

/**
 * Upper bound on token length accepted from the renderer. Session tokens are
 * opaque 256-bit values (well under 100 chars); 4 KiB is a generous ceiling
 * that also tolerates a future longer format while blocking absurd payloads.
 */
const MAX_TOKEN_LENGTH = 4096;

const setTokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Guard so we register IPC handlers exactly once across re-activations. */
let ipcRegistered = false;

function sessionFilePath(): string {
  return join(app.getPath("userData"), SESSION_FILE);
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// ---------------------------------------------------------------------------
// Encrypted persistence
// ---------------------------------------------------------------------------

/**
 * Read and decrypt the persisted token. Returns null when nothing is stored,
 * encryption is unavailable, or the ciphertext can't be decrypted (e.g. a
 * different OS user / rotated keychain) — the renderer then falls back to the
 * auth screen rather than crashing.
 */
async function readToken(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      "[secure-token] OS encryption unavailable — no persisted token can be read.",
    );
    return null;
  }
  let ciphertext: Buffer;
  try {
    ciphertext = await fs.readFile(sessionFilePath());
  } catch (err) {
    if (isENOENT(err)) {
      return null; // no session persisted yet
    }
    console.warn("[secure-token] failed to read session file:", err);
    return null;
  }
  if (ciphertext.length === 0) {
    return null;
  }
  try {
    return safeStorage.decryptString(ciphertext);
  } catch (err) {
    console.warn("[secure-token] failed to decrypt session token:", err);
    return null;
  }
}

/**
 * Encrypt and persist the token. FAIL SAFE: when OS encryption is unavailable,
 * refuse to write rather than persist plaintext — the session simply won't
 * survive a restart, but a token is never stored unencrypted.
 */
async function writeToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      "[secure-token] OS encryption unavailable — refusing to persist token " +
        "(fail-safe: never writing a plaintext token to disk).",
    );
    return;
  }
  const ciphertext = safeStorage.encryptString(token);
  const path = sessionFilePath();
  const tmpPath = `${path}.tmp`;
  // Atomic replace: write ciphertext to a temp file, then rename over the
  // target so a crash mid-write can't corrupt an existing session.
  await fs.writeFile(tmpPath, ciphertext, { mode: 0o600 });
  try {
    await fs.rename(tmpPath, path);
  } catch (err) {
    // Clean up the temp file on a failed rename; don't leave litter behind.
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/** Delete the persisted token file (best effort; missing file is fine). */
async function clearToken(): Promise<void> {
  try {
    await fs.unlink(sessionFilePath());
  } catch (err) {
    if (!isENOENT(err)) {
      console.warn("[secure-token] failed to clear session file:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle(
    SECURE_TOKEN_CHANNELS.get,
    async (): Promise<string | null> => {
      return readToken();
    },
  );

  ipcMain.handle(
    SECURE_TOKEN_CHANNELS.set,
    async (_event: IpcMainInvokeEvent, rawToken: unknown): Promise<void> => {
      const parsed = setTokenSchema.safeParse(rawToken);
      if (!parsed.success) {
        throw new Error("secure-token: invalid token payload");
      }
      await writeToken(parsed.data);
    },
  );

  ipcMain.handle(SECURE_TOKEN_CHANNELS.clear, async (): Promise<void> => {
    await clearToken();
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the secure token store. Call once, after `app.whenReady()`, from the
 * main process. Registers the validated get/set/clear IPC handlers.
 */
export function registerSecureTokenStore(): void {
  registerIpcHandlers();
}
