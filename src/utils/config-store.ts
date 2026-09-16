/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** JSON schema for ~/.brightspace-mcp/config.json */
export interface ConfigStoreData {
  baseUrl?: string;
  username?: string;
  password?: string;
  /** TOTP shared secret (base32) or full otpauth:// URI for the second factor. */
  totpSecret?: string;
  sessionDir?: string;
  tokenTtl?: number;
  headless?: boolean;
  includeCourses?: number[];
  excludeCourses?: number[];
  activeOnly?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".brightspace-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function configStoreExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfigStore(): ConfigStoreData {
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as ConfigStoreData;
}

export function saveConfigStore(config: ConfigStoreData): void {
  const isWindows = process.platform === "win32";
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, ...(isWindows ? {} : { mode: 0o700 }) });
  }
  writeConfigFileAtomically(JSON.stringify(config, null, 2) + "\n");
}

/**
 * Write the config file by creating a temp file and renaming it over the target,
 * so a reader sees either the whole old file or the whole new one.
 * fs.writeFileSync truncates in place, which means a crash, power loss or ENOSPC
 * mid-write leaves a truncated or empty config. That is worse than losing a
 * session token: the token is re-mintable by logging in, whereas this file holds
 * the password and TOTP secret that make logging in unattended possible at all.
 *
 * The temp file lives in CONFIG_DIR itself: rename is only atomic within one
 * filesystem, and os.tmpdir() may be on a different one.
 */
function writeConfigFileAtomically(contents: string): void {
  const isWindows = process.platform === "win32";
  // pid plus random bytes: two processes saving at once must not pick the same
  // temp path and rename each other's half-written file over the target.
  const tempPath = `${CONFIG_FILE}.${process.pid}.${crypto
    .randomBytes(6)
    .toString("hex")}.tmp`;

  try {
    // The temp file holds credentials, so it is owner-only from creation rather
    // than chmod'd afterwards — a window where it is world-readable is a window
    // where the password leaks. "wx" refuses to reuse a path that somehow
    // already exists instead of overwriting whatever is there.
    const fd = fs.openSync(tempPath, "wx", isWindows ? undefined : 0o600);
    try {
      fs.writeFileSync(fd, contents, { encoding: "utf-8" });
      // fsync before the rename. Writing only hands the bytes to the page cache,
      // so on a power loss the kernel may have made the rename durable while the
      // contents are still in flight — the failure this whole function exists to
      // prevent, an empty file under the real name. fsync buys durability of the
      // data, not of the directory entry: CONFIG_DIR itself is not synced, so a
      // crash can still lose the rename entirely. That outcome is fine, because
      // it leaves the previous config whole.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameOverConfigFile(tempPath);
  } catch (error) {
    // Never let a failing disk litter the config dir with the user's password.
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Cleanup is best-effort; the original failure is what the caller needs.
    }
    throw error;
  }
}

/**
 * Rename the temp file over the config file, retrying briefly on Windows.
 *
 * POSIX rename over an existing file always succeeds atomically. Windows can
 * fail it with EPERM/EACCES/EBUSY while another process — the other half of this
 * server, an editor, a virus scanner — has the target open. That failure is
 * harmless, since the old config survives, but it would surface to the user as a
 * save that did not happen, so it is worth a few short retries. Other platforms
 * take the single attempt. The wait is Atomics.wait rather than a timer because
 * saveConfigStore is synchronous and its callers depend on that.
 */
function renameOverConfigFile(tempPath: string): void {
  const maxAttempts = process.platform === "win32" ? 5 : 1;

  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tempPath, CONFIG_FILE);
      return;
    } catch (error: any) {
      const transient =
        error?.code === "EPERM" ||
        error?.code === "EACCES" ||
        error?.code === "EBUSY";
      if (!transient || attempt >= maxAttempts) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

export function getConfigStorePath(): string {
  return CONFIG_FILE;
}
