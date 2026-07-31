import {
  app,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SECURE_VAULT_CHANNELS } from "./secure-vault-types";

/**
 * Secure account-vault store (main process) — M15 / ADR 0013.
 *
 * A SECOND encrypted single-value slot beside `secure-token.ts`. It persists the
 * multi-account vault blob (the registry of every signed-in account: their
 * session tokens + cached display profiles) that the account switcher flips
 * between. Kept as its own fixed file rather than overloading the single token
 * slot, exactly as ADR 0013 §2 prescribes — `session.bin` stays the boot
 * fast-cache; this holds the full registry.
 *
 * Security posture is IDENTICAL to the token store (CLAUDE.md §9, §28) — the
 * vault holds MULTIPLE tokens, so it is at least as sensitive:
 *   - The blob is encrypted with `safeStorage.encryptString` before it ever
 *     touches disk; only ciphertext is written.
 *   - FAIL SAFE: if `safeStorage.isEncryptionAvailable()` is false, we do NOT
 *     fall back to plaintext. `set` no-ops (logs a warning), `get` returns null.
 *   - Every `set` payload is zod-validated (non-empty, bounded length) first.
 *   - The file is written atomically (tmp + rename) with 0600 perms.
 */

// ---------------------------------------------------------------------------
// Limits & storage location
// ---------------------------------------------------------------------------

/** Ciphertext file name under the app's userData directory. */
const VAULT_FILE = "account-vault.bin";

/**
 * Upper bound on the serialized vault blob accepted from the renderer. The vault
 * caps at MAX_STORED_ACCOUNTS = 8 records, each an opaque token (~100 chars) plus
 * a few short profile strings — well under a few KiB. 64 KiB is a generous
 * ceiling that blocks absurd payloads while tolerating future record growth.
 */
const MAX_VAULT_LENGTH = 64 * 1024;

const setVaultSchema = z.string().min(1).max(MAX_VAULT_LENGTH);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Guard so we register IPC handlers exactly once across re-activations. */
let ipcRegistered = false;

function vaultFilePath(): string {
  return join(app.getPath("userData"), VAULT_FILE);
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
 * Read and decrypt the persisted vault. Returns null when nothing is stored,
 * encryption is unavailable, or the ciphertext can't be decrypted (e.g. a
 * different OS user / rotated keychain) — the renderer then starts from an empty
 * vault rather than crashing (the shared `normalizeAccountVault` already treats
 * null/garbage as "empty vault").
 */
async function readVault(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      "[secure-vault] OS encryption unavailable — no persisted vault can be read.",
    );
    return null;
  }
  let ciphertext: Buffer;
  try {
    ciphertext = await fs.readFile(vaultFilePath());
  } catch (err) {
    if (isENOENT(err)) {
      return null; // no vault persisted yet
    }
    console.warn("[secure-vault] failed to read vault file:", err);
    return null;
  }
  if (ciphertext.length === 0) {
    return null;
  }
  try {
    return safeStorage.decryptString(ciphertext);
  } catch (err) {
    console.warn("[secure-vault] failed to decrypt vault:", err);
    return null;
  }
}

/**
 * Encrypt and persist the vault. FAIL SAFE: when OS encryption is unavailable,
 * refuse to write rather than persist plaintext tokens — the accounts simply
 * won't survive a restart, but tokens are never stored unencrypted.
 */
async function writeVault(value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      "[secure-vault] OS encryption unavailable — refusing to persist vault " +
        "(fail-safe: never writing plaintext tokens to disk).",
    );
    return;
  }
  const ciphertext = safeStorage.encryptString(value);
  const path = vaultFilePath();
  const tmpPath = `${path}.tmp`;
  // Atomic replace: write ciphertext to a temp file, then rename over the
  // target so a crash mid-write can't corrupt an existing vault.
  await fs.writeFile(tmpPath, ciphertext, { mode: 0o600 });
  try {
    await fs.rename(tmpPath, path);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/** Delete the persisted vault file (best effort; missing file is fine). */
async function clearVault(): Promise<void> {
  try {
    await fs.unlink(vaultFilePath());
  } catch (err) {
    if (!isENOENT(err)) {
      console.warn("[secure-vault] failed to clear vault file:", err);
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

  ipcMain.handle(SECURE_VAULT_CHANNELS.get, async (): Promise<string | null> => {
    return readVault();
  });

  ipcMain.handle(
    SECURE_VAULT_CHANNELS.set,
    async (_event: IpcMainInvokeEvent, rawValue: unknown): Promise<void> => {
      const parsed = setVaultSchema.safeParse(rawValue);
      if (!parsed.success) {
        throw new Error("secure-vault: invalid vault payload");
      }
      await writeVault(parsed.data);
    },
  );

  ipcMain.handle(SECURE_VAULT_CHANNELS.clear, async (): Promise<void> => {
    await clearVault();
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the secure account-vault store. Call once, after `app.whenReady()`,
 * from the main process (beside `registerSecureTokenStore`).
 */
export function registerSecureVaultStore(): void {
  registerIpcHandlers();
}
