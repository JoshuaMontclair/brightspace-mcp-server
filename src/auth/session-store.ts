/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TokenData, EncryptedData, SessionFile } from "../types/index.js";
import { SessionStoreError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".d2l-session");
const SESSION_FILE_NAME = "session.json";
const SESSION_VERSION = 1;

// Encryption constants
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16; // GCM auth tag length
const SALT_LENGTH = 16;
const SALT_FILE_NAME = "salt";
const KEY_LENGTH = 32; // 256 bits, for AES-256

// Exactly the names writeSessionFileAtomically mints — session.json.<pid>.<hex>.tmp
// — so the sweep can never reach a file this class did not write.
const TEMP_FILE_PATTERN = new RegExp(
  `^${SESSION_FILE_NAME.replace(/\./g, "\\.")}\\.\\d+\\.[0-9a-f]+\\.tmp$`
);

// How long a temp file must have sat untouched before the sweep may delete it.
// A save owns its temp file for milliseconds, so minutes of slack cost nothing
// and keep the sweep well clear of a writer that is merely slow.
const STALE_TEMP_FILE_AGE_MS = 5 * 60 * 1000;

/**
 * SessionStore manages encrypted token persistence to disk.
 * Uses AES-256-GCM for encryption with a key derived from the username and a
 * per-installation random salt.
 */
export class SessionStore {
  private readonly sessionDir: string;
  private readonly sessionFilePath: string;

  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir ?? DEFAULT_SESSION_DIR;
    this.sessionFilePath = path.join(this.sessionDir, SESSION_FILE_NAME);
  }

  /**
   * Read the existing salt, never creating one.
   * The load path uses this rather than getOrCreateSalt: minting a fresh salt
   * while reading old data would change the key and turn a session that is
   * merely unreadable right now into one that can never be recovered.
   */
  private readSalt(): Buffer {
    return fsSync.readFileSync(path.join(this.sessionDir, SALT_FILE_NAME));
  }

  /**
   * Get or create a random salt unique to this installation.
   * Stored at ~/.d2l-session/salt with restricted permissions.
   *
   * save() is its only caller, and deliberately so — see save().
   */
  private getOrCreateSalt(): Buffer {
    const saltPath = path.join(this.sessionDir, SALT_FILE_NAME);
    try {
      return this.readSalt();
    } catch {
      // Salt doesn't exist yet — create session dir and generate one
      const isWindows = process.platform === "win32";
      fsSync.mkdirSync(this.sessionDir, {
        recursive: true,
        ...(isWindows ? {} : { mode: 0o700 }),
      });
      const salt = crypto.randomBytes(SALT_LENGTH);
      fsSync.writeFileSync(saltPath, salt, {
        ...(isWindows ? {} : { mode: 0o600 }),
      });
      return salt;
    }
  }

  /**
   * Derive the AES-256 key from the username plus the per-installation salt.
   *
   * The hostname used to be part of the key material, but macOS rewrites the
   * hostname when the machine joins certain networks, so a user could lose a
   * saved session just by changing wifi. Narrowing the material costs nothing
   * real: neither the username nor the hostname is secret — anyone who can read
   * session.json can read both — so the salt is what actually supplies the
   * entropy, and it stays. This encryption keeps a token out of plaintext in
   * backups, sync folders and stray `cat`s; it was never a defence against
   * someone who already has read access to ~/.d2l-session, and a key derived
   * from stable material defends exactly as well against that.
   *
   * The salt is required, for the same reason decrypt()'s key is: a default of
   * getOrCreateSalt() would let any caller mint a salt by omitting an argument.
   */
  private deriveKey(salt: Buffer): Buffer {
    return crypto.scryptSync(os.userInfo().username, salt, KEY_LENGTH);
  }

  /**
   * The pre-migration key material (username + hostname), for reading sessions
   * written by older versions. Only load() uses it; nothing writes it any more.
   */
  private deriveLegacyKey(salt: Buffer): Buffer {
    return crypto.scryptSync(
      os.userInfo().username + os.hostname(),
      salt,
      KEY_LENGTH
    );
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Returns IV, auth tag, and ciphertext as hex strings.
   *
   * The key is required for the same reason decrypt()'s is: callers must say
   * which key they mean rather than have one derived — and possibly minted —
   * underneath them.
   */
  private encrypt(plaintext: string, key: Buffer): EncryptedData {
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      data: encrypted,
    };
  }

  /**
   * Decrypt ciphertext using AES-256-GCM.
   * Returns plaintext string, or throws if auth tag verification fails.
   *
   * The key is required, not defaulted to deriveKey(): a default would route a
   * bare this.decrypt(x) through getOrCreateSalt(), minting a salt while reading
   * old data and making a merely-unreadable session unrecoverable. Callers must
   * say which key they mean.
   */
  private decrypt(encrypted: EncryptedData, key: Buffer): string {
    const iv = Buffer.from(encrypted.iv, "hex");
    const authTag = Buffer.from(encrypted.authTag, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.data, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Save token to disk with encryption.
   * Creates session directory if it doesn't exist.
   */
  async save(token: TokenData): Promise<void> {
    let salt: Buffer;
    try {
      // This is the one call site allowed to mint a salt, and the only reason
      // getOrCreateSalt still exists: the very first save on an installation has
      // none to read. Every other writer — load()'s legacy migration included —
      // goes through writeSession with the salt it already read, so "mint a salt
      // while reading" is not a call this class can express.
      salt = this.getOrCreateSalt();
    } catch (error) {
      throw this.saveFailure(error);
    }

    await this.writeSession(token, salt);
  }

  /** Encrypt and write the session under a salt the caller already has. */
  private async writeSession(token: TokenData, salt: Buffer): Promise<void> {
    try {
      // Ensure session directory exists with restricted permissions (owner-only on Unix)
      const isWindows = process.platform === "win32";
      await fs.mkdir(this.sessionDir, {
        recursive: true,
        ...(isWindows ? {} : { mode: 0o700 }),
      });

      const plaintext = JSON.stringify(token);
      const encrypted = this.encrypt(plaintext, this.deriveKey(salt));

      const sessionFile: SessionFile = {
        version: SESSION_VERSION,
        encrypted,
        createdAt: Date.now(),
        expiresAt: token.expiresAt,
      };

      await this.writeSessionFileAtomically(
        JSON.stringify(sessionFile, null, 2)
      );

      log("DEBUG", `Session saved to ${this.sessionFilePath}`);

      await this.sweepStaleTempFiles();
    } catch (error) {
      throw this.saveFailure(error);
    }
  }

  /** Both halves of the save path fail the same way, so they say so the same way. */
  private saveFailure(error: unknown): SessionStoreError {
    const err = error instanceof Error ? error : new Error(String(error));
    log("ERROR", `Failed to save session: ${err.message}`);
    return new SessionStoreError("Failed to save session", err);
  }

  /**
   * Write the session file by creating a temp file and renaming it over the
   * target, so a reader sees either the whole old file or the whole new one.
   * fs.writeFile truncates in place, which means a crash, power loss or ENOSPC
   * mid-write destroys the previous session — and since load() now writes too
   * (the one-time legacy re-encryption), that would be a session that was
   * perfectly readable a moment earlier.
   *
   * The temp file lives in the target's own directory: rename is only atomic
   * within one filesystem, and os.tmpdir() may be on a different one.
   */
  private async writeSessionFileAtomically(contents: string): Promise<void> {
    const isWindows = process.platform === "win32";
    // pid plus random bytes: two processes saving at once must not pick the same
    // temp path and rename each other's half-written file over the target.
    const tempPath = `${this.sessionFilePath}.${process.pid}.${crypto
      .randomBytes(6)
      .toString("hex")}.tmp`;

    try {
      // Opened by hand rather than via fs.writeFile so the bytes can be flushed
      // before the rename commits: writeFile returns once the data is in the
      // page cache, and nothing orders that data against the rename. A crash or
      // ENOSPC is already survived by the rename either way, but a power loss is
      // not — off ext4, whose rename-over-existing heuristic flushes for you,
      // the rename can land while the data blocks never do, leaving a
      // zero-length session.json where a good session used to be.
      //
      // The temp file holds a session token, so it is owner-only from creation
      // rather than chmod'd afterwards. "wx" refuses to reuse a path that
      // somehow already exists instead of overwriting whatever is there.
      const handle = await fs.open(
        tempPath,
        "wx",
        isWindows ? undefined : 0o600
      );
      try {
        await handle.writeFile(contents, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.renameOverSessionFile(tempPath);
    } catch (error) {
      // Never let a failing disk litter the session directory with tokens.
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    await this.syncSessionDir();
  }

  /**
   * Flush the directory entry the rename just created.
   *
   * What this buys: the rename is atomic with or without it, but only the
   * directory sync bounds when it becomes *durable*, so a power loss cannot
   * resurrect the old file after save() resolved. What it does not buy: any
   * ordering guarantee against other files, and on macOS plain fsync does not
   * force the drive's own write cache (that needs F_FULLFSYNC, which Node does
   * not expose) — this closes the page-cache window, not every window.
   *
   * Best effort by design: Windows cannot open a directory as a file at all,
   * and the data itself is already on disk, so a failure here must not turn a
   * committed save into a reported failure.
   */
  private async syncSessionDir(): Promise<void> {
    try {
      const dir = await fs.open(this.sessionDir, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Nothing to report: the session file is written either way.
    }
  }

  /**
   * Delete temp files abandoned by a save that died between write and rename.
   *
   * Without this, a SIGKILL or power loss leaves an encrypted token sitting in
   * the session directory forever — clear() only unlinks session.json, so even
   * logging out would not remove it.
   *
   * Only files untouched for STALE_TEMP_FILE_AGE_MS are eligible, and that age
   * check is the whole sweep rather than a refinement of it: another process may
   * have a temp file in flight, and deleting it would make its rename fail and
   * cost that user a token refresh — strictly worse than leaving a remnant for
   * one more save. A live writer's temp file is milliseconds old, so the cutoff
   * separates the two cases cleanly without any cross-process locking.
   *
   * It runs after a save has committed and after clear(), never before a write:
   * it is housekeeping, so it neither blocks nor fails the operation it follows.
   */
  private async sweepStaleTempFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.sessionDir);
      const cutoff = Date.now() - STALE_TEMP_FILE_AGE_MS;

      await Promise.all(
        entries
          .filter((entry) => TEMP_FILE_PATTERN.test(entry))
          .map(async (entry) => {
            const tempPath = path.join(this.sessionDir, entry);
            try {
              const stats = await fs.stat(tempPath);
              if (stats.mtimeMs < cutoff) {
                await fs.rm(tempPath, { force: true });
                log("DEBUG", `Removed stale session temp file ${tempPath}`);
              }
            } catch {
              // Raced with its owner or with another sweep; either way it is
              // no longer ours to worry about.
            }
          })
      );
    } catch {
      // An unreadable session directory is the caller's problem, not the
      // sweep's — it has already been reported by whatever tried to use it.
    }
  }

  /**
   * Rename the temp file over the session file, retrying briefly on Windows.
   *
   * POSIX rename over an existing file always succeeds atomically. Windows can
   * fail it with EPERM/EACCES/EBUSY while another process has the target open —
   * harmlessly, since the old file survives, but it would surface as a spurious
   * save failure and cost the user a token refresh, so it is worth a few short
   * retries. Other platforms take the single attempt.
   */
  private async renameOverSessionFile(tempPath: string): Promise<void> {
    const maxAttempts = process.platform === "win32" ? 5 : 1;

    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(tempPath, this.sessionFilePath);
        return;
      } catch (error: any) {
        const transient =
          error?.code === "EPERM" ||
          error?.code === "EACCES" ||
          error?.code === "EBUSY";
        if (!transient || attempt >= maxAttempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  }

  /**
   * Load token from disk with decryption.
   * Returns null if file doesn't exist or is corrupted (graceful degradation).
   */
  async load(): Promise<TokenData | null> {
    try {
      // Check if file exists
      try {
        await fs.access(this.sessionFilePath);
      } catch {
        log("DEBUG", "No session file found");
        return null;
      }

      // Read and parse session file
      const fileContent = await fs.readFile(this.sessionFilePath, "utf-8");
      const sessionFile: SessionFile = JSON.parse(fileContent);

      // Read the salt rather than minting one: see readSalt.
      const salt = this.readSalt();

      let plaintext: string;
      let usedLegacyKey = false;
      try {
        plaintext = this.decrypt(sessionFile.encrypted, this.deriveKey(salt));
      } catch {
        // Written before the hostname was dropped from the key material.
        // Trying a second key is safe because GCM authenticates: a corrupted or
        // tampered file fails under both keys and falls through to the catch
        // below, which still returns null.
        plaintext = this.decrypt(
          sessionFile.encrypted,
          this.deriveLegacyKey(salt)
        );
        usedLegacyKey = true;
      }

      const token: TokenData = JSON.parse(plaintext);

      if (usedLegacyKey) {
        // Migrate in place so the fallback is needed exactly once. A failure
        // here is not fatal — the session itself is fine and the next load
        // simply falls back again — so it must not fail the load.
        //
        // It hands over the salt it just read instead of calling save(): the
        // migration is reached from a read, and a read must never be able to
        // mint a salt.
        try {
          await this.writeSession(token, salt);
          log("DEBUG", "Re-encrypted session with the hostname-free key");
        } catch {
          log("WARN", "Could not re-encrypt legacy session; will retry later");
        }
      }

      log("DEBUG", `Session loaded from ${this.sessionFilePath}`);
      return token;
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(String(error));
      log("WARN", `Failed to load session: ${err.message}`);
      // Return null instead of throwing - graceful degradation
      return null;
    }
  }

  /**
   * Clear session by deleting the session file.
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath);
      log("DEBUG", `Session cleared: ${this.sessionFilePath}`);
    } catch (error: any) {
      // Ignore ENOENT errors - file already doesn't exist
      if (error.code !== "ENOENT") {
        const err =
          error instanceof Error ? error : new Error(String(error));
        log("WARN", `Failed to clear session: ${err.message}`);
      }
    }

    // Logging out should not leave a token behind under another name. A temp
    // file younger than the cutoff is left alone even here: it may belong to a
    // save still in flight, and the next save or clear will collect it.
    await this.sweepStaleTempFiles();
  }
}
