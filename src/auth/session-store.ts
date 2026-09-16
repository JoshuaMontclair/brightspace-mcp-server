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
   */
  private deriveKey(salt?: Buffer): Buffer {
    return crypto.scryptSync(
      os.userInfo().username,
      salt ?? this.getOrCreateSalt(),
      KEY_LENGTH
    );
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
   */
  private encrypt(plaintext: string): EncryptedData {
    const key = this.deriveKey();
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
   */
  private decrypt(encrypted: EncryptedData, key: Buffer = this.deriveKey()): string {
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
    try {
      // Ensure session directory exists with restricted permissions (owner-only on Unix)
      const isWindows = process.platform === "win32";
      await fs.mkdir(this.sessionDir, {
        recursive: true,
        ...(isWindows ? {} : { mode: 0o700 }),
      });

      const plaintext = JSON.stringify(token);
      const encrypted = this.encrypt(plaintext);

      const sessionFile: SessionFile = {
        version: SESSION_VERSION,
        encrypted,
        createdAt: Date.now(),
        expiresAt: token.expiresAt,
      };

      await fs.writeFile(
        this.sessionFilePath,
        JSON.stringify(sessionFile, null, 2),
        {
          encoding: "utf-8",
          ...(isWindows ? {} : { mode: 0o600 }),
        }
      );

      log("DEBUG", `Session saved to ${this.sessionFilePath}`);
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(String(error));
      log("ERROR", `Failed to save session: ${err.message}`);
      throw new SessionStoreError("Failed to save session", err);
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
        try {
          await this.save(token);
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
  }
}
