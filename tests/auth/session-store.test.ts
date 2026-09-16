import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/auth/session-store.js";
import type { TokenData } from "../../src/types/index.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("SessionStore", () => {
  let testDir: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    // Create isolated temp directory for each test
    testDir = path.join(
      os.tmpdir(),
      `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    sessionStore = new SessionStore(testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("encrypt/decrypt", () => {
    it("encrypt then decrypt returns original plaintext", () => {
      const plaintext = JSON.stringify({
        accessToken: "test-token-12345",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      });

      // Access private methods via any cast for testing
      const store = sessionStore as any;
      const encrypted = store.encrypt(plaintext);
      const decrypted = store.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();
      expect(encrypted.data).toBeTruthy();
    });
  });

  describe("save and load", () => {
    it("save then load returns same TokenData", async () => {
      const token: TokenData = {
        accessToken: "test-token-abc123",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };

      await sessionStore.save(token);
      const loaded = await sessionStore.load();

      expect(loaded).toEqual(token);
    });

    it("load returns null when no session file exists", async () => {
      const loaded = await sessionStore.load();
      expect(loaded).toBeNull();
    });

    it("load returns null when session file is corrupted", async () => {
      // Create the session directory
      await fs.mkdir(testDir, { recursive: true });

      // Write garbage data to session file
      const sessionFile = path.join(testDir, "session.json");
      await fs.writeFile(sessionFile, "this is not valid JSON!");

      const loaded = await sessionStore.load();
      expect(loaded).toBeNull();
    });

    it("load returns null when session file has tampered ciphertext", async () => {
      // First save a valid token
      const token: TokenData = {
        accessToken: "test-token-tamper",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };
      await sessionStore.save(token);

      // Tamper with the encrypted data
      const sessionFile = path.join(testDir, "session.json");
      const fileContent = await fs.readFile(sessionFile, "utf-8");
      const sessionData = JSON.parse(fileContent);

      // Modify the ciphertext - flip some bits
      const tamperedData = sessionData.encrypted.data
        .split("")
        .map((c: string, i: number) => (i % 2 === 0 ? (c === "a" ? "b" : "a") : c))
        .join("");
      sessionData.encrypted.data = tamperedData;

      await fs.writeFile(sessionFile, JSON.stringify(sessionData));

      // Load should return null due to auth tag verification failure
      const loaded = await sessionStore.load();
      expect(loaded).toBeNull();
    });

    it("creates session directory if it does not exist", async () => {
      const token: TokenData = {
        accessToken: "test-token-mkdir",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };

      // testDir does not exist yet
      await sessionStore.save(token);

      // Verify directory was created
      const stats = await fs.stat(testDir);
      expect(stats.isDirectory()).toBe(true);

      // Verify file exists
      const sessionFile = path.join(testDir, "session.json");
      const fileStats = await fs.stat(sessionFile);
      expect(fileStats.isFile()).toBe(true);
    });
  });

  describe("clear", () => {
    it("clear removes session file", async () => {
      const token: TokenData = {
        accessToken: "test-token-clear",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };

      await sessionStore.save(token);

      // Verify file exists
      const sessionFile = path.join(testDir, "session.json");
      let stats = await fs.stat(sessionFile);
      expect(stats.isFile()).toBe(true);

      // Clear session
      await sessionStore.clear();

      // Load should return null
      const loaded = await sessionStore.load();
      expect(loaded).toBeNull();

      // File should not exist
      try {
        await fs.stat(sessionFile);
        expect.fail("Session file should not exist after clear");
      } catch (error: any) {
        expect(error.code).toBe("ENOENT");
      }
    });
  });

  describe("key derivation and legacy migration", () => {
    const SALT_LENGTH = 16;
    const IV_LENGTH = 12;
    const ALGORITHM = "aes-256-gcm";
    const KEY_LENGTH = 32;

    /** The key the store writes with today: username + per-installation salt. */
    function newKey(salt: Buffer): Buffer {
      return crypto.scryptSync(os.userInfo().username, salt, KEY_LENGTH);
    }

    /** The pre-migration key: username + hostname + the same salt. */
    function legacyKey(salt: Buffer): Buffer {
      return crypto.scryptSync(
        os.userInfo().username + os.hostname(),
        salt,
        KEY_LENGTH
      );
    }

    /** Seed the session dir with a salt, as an existing installation would have. */
    async function seedSalt(): Promise<Buffer> {
      await fs.mkdir(testDir, { recursive: true });
      const salt = crypto.randomBytes(SALT_LENGTH);
      await fs.writeFile(path.join(testDir, "salt"), salt);
      return salt;
    }

    async function readSessionFile(): Promise<any> {
      return JSON.parse(
        await fs.readFile(path.join(testDir, "session.json"), "utf-8")
      );
    }

    function decryptWith(encrypted: any, key: Buffer): string {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(encrypted.iv, "hex")
      );
      decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
      return (
        decipher.update(encrypted.data, "hex", "utf8") + decipher.final("utf8")
      );
    }

    /** Write the exact envelope an older version of the store would have left. */
    async function writeLegacySession(
      salt: Buffer,
      token: TokenData
    ): Promise<any> {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, legacyKey(salt), iv);
      let data = cipher.update(JSON.stringify(token), "utf8", "hex");
      data += cipher.final("hex");

      const sessionFile = {
        version: 1,
        encrypted: {
          iv: iv.toString("hex"),
          authTag: cipher.getAuthTag().toString("hex"),
          data,
        },
        createdAt: Date.now(),
        expiresAt: token.expiresAt,
      };

      await fs.writeFile(
        path.join(testDir, "session.json"),
        JSON.stringify(sessionFile, null, 2),
        "utf-8"
      );
      return sessionFile;
    }

    const token: TokenData = {
      accessToken: "test-token-migration",
      capturedAt: 1700000000000,
      expiresAt: 1700003600000,
      source: "browser",
    };

    it("round trips a session under the hostname-free key", async () => {
      await sessionStore.save(token);

      expect(await sessionStore.load()).toEqual(token);

      // The bytes on disk are readable with username + salt alone, so a
      // hostname change cannot cost the user their session.
      const salt = await fs.readFile(path.join(testDir, "salt"));
      const onDisk = await readSessionFile();
      expect(JSON.parse(decryptWith(onDisk.encrypted, newKey(salt)))).toEqual(
        token
      );
    });

    it("loads a session written with the legacy username + hostname key", async () => {
      const salt = await seedSalt();
      await writeLegacySession(salt, token);

      expect(await sessionStore.load()).toEqual(token);
    });

    it("rewrites a legacy session under the new key on first load", async () => {
      const salt = await seedSalt();
      const legacyFile = await writeLegacySession(salt, token);

      await sessionStore.load();

      const migrated = await readSessionFile();
      expect(migrated.encrypted.data).not.toBe(legacyFile.encrypted.data);
      // Decrypting with the new key directly proves the fallback is no longer
      // what makes this file readable.
      expect(
        JSON.parse(decryptWith(migrated.encrypted, newKey(salt)))
      ).toEqual(token);
    });

    it("does not fall back again once a legacy session has been migrated", async () => {
      const salt = await seedSalt();
      await writeLegacySession(salt, token);

      await sessionStore.load();
      const afterMigration = await readSessionFile();

      expect(await sessionStore.load()).toEqual(token);

      // A second fallback would re-save and mint a fresh IV, so identical bytes
      // mean the legacy key was never reached.
      expect(await readSessionFile()).toEqual(afterMigration);
    });

    it("returns null for a tampered legacy session rather than trusting either key", async () => {
      const salt = await seedSalt();
      const legacyFile = await writeLegacySession(salt, token);

      legacyFile.encrypted.data =
        legacyFile.encrypted.data.slice(0, -2) +
        (legacyFile.encrypted.data.endsWith("00") ? "11" : "00");
      await fs.writeFile(
        path.join(testDir, "session.json"),
        JSON.stringify(legacyFile, null, 2),
        "utf-8"
      );

      expect(await sessionStore.load()).toBeNull();
    });

    it("does not create a salt when loading without one", async () => {
      await sessionStore.save(token);

      const saltPath = path.join(testDir, "salt");
      const salt = await fs.readFile(saltPath);
      await fs.rm(saltPath);

      expect(await sessionStore.load()).toBeNull();

      // Minting a salt here would change the key and make the session
      // unrecoverable; putting the original back must be enough to read it.
      await expect(fs.access(saltPath)).rejects.toThrow();
      await fs.writeFile(saltPath, salt);
      expect(await sessionStore.load()).toEqual(token);
    });
  });
});
