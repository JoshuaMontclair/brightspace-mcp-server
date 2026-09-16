import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/auth/session-store.js";
import { SessionStoreError } from "../../src/utils/errors.js";
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
      const key = store.deriveKey(crypto.randomBytes(16));
      const encrypted = store.encrypt(plaintext, key);
      const decrypted = store.decrypt(encrypted, key);

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

    it("mints the salt on the first save and reuses it afterwards", async () => {
      const token: TokenData = {
        accessToken: "test-token-first-save",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };

      // Saving is the only path allowed to create a salt, and the first save on
      // a fresh installation has none to read — so it must still work here.
      await sessionStore.save(token);
      const salt = await fs.readFile(path.join(testDir, "salt"));
      expect(salt.length).toBe(16);

      await sessionStore.save({ ...token, accessToken: "second-token" });
      expect(await fs.readFile(path.join(testDir, "salt"))).toEqual(salt);
      expect(await sessionStore.load()).toEqual({
        ...token,
        accessToken: "second-token",
      });
    });

    it("throws SessionStoreError when the session directory cannot be created", async () => {
      // A plain file where the session directory belongs, so mkdir cannot create it.
      const token: TokenData = {
        accessToken: "test-token-enotdir",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };
      await fs.writeFile(testDir, "not a directory");
      const blocked = new SessionStore(path.join(testDir, "nested"));

      await expect(blocked.save(token)).rejects.toThrow(SessionStoreError);
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

    it("migrates using the salt it read, leaving that salt untouched", async () => {
      const salt = await seedSalt();
      await writeLegacySession(salt, token);

      await sessionStore.load();

      // A migration that minted its own salt would both replace these bytes and
      // strand the session under a key nothing can derive again.
      expect(await fs.readFile(path.join(testDir, "salt"))).toEqual(salt);
      expect(
        JSON.parse(decryptWith((await readSessionFile()).encrypted, newKey(salt)))
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

  describe("atomic save", () => {
    // The fsync before the rename has no filesystem-visible effect: a process
    // that exits normally leaves the same bytes either way, and only a power cut
    // between the write and the rename tells the two apart. Nothing below tries
    // to prove it — a test that only asserts sync() was called would pin the
    // implementation, not the behaviour.

    // chmod is a no-op on Windows and file modes are not POSIX there, so the
    // tests that hinge on either are Unix-only rather than silently vacuous.
    const unixOnly = process.platform === "win32" ? it.skip : it;

    // Root ignores the directory permission bits, so a write these tests expect
    // to be refused would quietly succeed and the test would fail for a reason
    // that has nothing to do with the code under test.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const asUser =
      process.platform === "win32" || isRoot ? it.skip : it;

    const token: TokenData = {
      accessToken: "test-token-atomic",
      capturedAt: 1700000000000,
      expiresAt: 1700003600000,
      source: "browser",
    };

    /** Everything in the session dir that is not one of the two real files. */
    async function strayFiles(): Promise<string[]> {
      const entries = await fs.readdir(testDir);
      return entries.filter((e) => e !== "session.json" && e !== "salt").sort();
    }

    it("leaves no temp file behind after a successful save", async () => {
      await sessionStore.save(token);

      expect(await strayFiles()).toEqual([]);
    });

    it("leaves no temp file behind when the write cannot be committed", async () => {
      await fs.mkdir(testDir, { recursive: true });
      // A directory where the session file belongs: the temp file is written and
      // only the rename fails, which exercises the cleanup path rather than the
      // cheaper case where nothing was ever created.
      await fs.mkdir(path.join(testDir, "session.json"));

      await expect(sessionStore.save(token)).rejects.toThrow(SessionStoreError);

      expect(await strayFiles()).toEqual([]);
    });

    unixOnly("saves the session file with owner-only permissions", async () => {
      await sessionStore.save(token);

      const stats = await fs.stat(path.join(testDir, "session.json"));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    asUser("keeps the previous session loadable when a save fails", async () => {
      await sessionStore.save(token);

      // Read-only session dir: the save fails with a good session already on
      // disk, which is exactly the crash-mid-write this change exists to survive.
      await fs.chmod(testDir, 0o500);
      try {
        await expect(
          sessionStore.save({ ...token, accessToken: "replacement-token" })
        ).rejects.toThrow(SessionStoreError);
      } finally {
        await fs.chmod(testDir, 0o700);
      }

      expect(await sessionStore.load()).toEqual(token);
    });

    asUser(
      "keeps a legacy session readable when its migration cannot be written",
      async () => {
        await fs.mkdir(testDir, { recursive: true });
        const salt = crypto.randomBytes(16);
        await fs.writeFile(path.join(testDir, "salt"), salt);

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(
          "aes-256-gcm",
          crypto.scryptSync(os.userInfo().username + os.hostname(), salt, 32),
          iv
        );
        let data = cipher.update(JSON.stringify(token), "utf8", "hex");
        data += cipher.final("hex");
        const legacyBytes = JSON.stringify({
          version: 1,
          encrypted: {
            iv: iv.toString("hex"),
            authTag: cipher.getAuthTag().toString("hex"),
            data,
          },
          createdAt: Date.now(),
          expiresAt: token.expiresAt,
        });
        const sessionFile = path.join(testDir, "session.json");
        await fs.writeFile(sessionFile, legacyBytes, "utf-8");

        await fs.chmod(testDir, 0o500);
        try {
          // The in-place re-encryption fails, but it must not cost the caller
          // the session it just decrypted.
          expect(await sessionStore.load()).toEqual(token);
        } finally {
          await fs.chmod(testDir, 0o700);
        }

        // Byte-for-byte the legacy file: the failed migration replaced nothing,
        // so the next load falls back and retries.
        expect(await fs.readFile(sessionFile, "utf-8")).toBe(legacyBytes);
        expect(await sessionStore.load()).toEqual(token);
        expect(await strayFiles()).toEqual([]);
      }
    );
  });

  describe("stale temp file sweep", () => {
    const token: TokenData = {
      accessToken: "test-token-sweep",
      capturedAt: 1700000000000,
      expiresAt: 1700003600000,
      source: "browser",
    };

    /**
     * A file in exactly the form a save killed between write and rename leaves
     * behind, backdated by ageMs.
     */
    async function leaveTempFile(name: string, ageMs: number): Promise<string> {
      await fs.mkdir(testDir, { recursive: true });
      const tempPath = path.join(testDir, name);
      await fs.writeFile(tempPath, "leftover ciphertext");
      const when = new Date(Date.now() - ageMs);
      await fs.utimes(tempPath, when, when);
      return tempPath;
    }

    const stale = 60 * 60 * 1000;

    it("removes a temp file abandoned by a killed save", async () => {
      const abandoned = await leaveTempFile(
        "session.json.4242.0123456789ab.tmp",
        stale
      );

      await sessionStore.save(token);

      await expect(fs.access(abandoned)).rejects.toThrow();
      expect(await sessionStore.load()).toEqual(token);
    });

    it("leaves a fresh temp file alone, because a live writer may own it", async () => {
      const inFlight = await leaveTempFile(
        "session.json.4243.0123456789ac.tmp",
        0
      );

      await sessionStore.save(token);

      // Deleting this would make the other process's rename fail; a remnant for
      // one more save is the cheaper mistake.
      expect(await fs.readFile(inFlight, "utf-8")).toBe("leftover ciphertext");
    });

    it("removes an abandoned temp file on clear, so logout leaves no token", async () => {
      await sessionStore.save(token);
      const abandoned = await leaveTempFile(
        "session.json.4244.0123456789ad.tmp",
        stale
      );

      await sessionStore.clear();

      expect(await fs.readdir(testDir)).toEqual(["salt"]);
      await expect(fs.access(abandoned)).rejects.toThrow();
    });

    it("sweeps even when there is no session file to clear", async () => {
      const abandoned = await leaveTempFile(
        "session.json.4245.0123456789ae.tmp",
        stale
      );

      await sessionStore.clear();

      await expect(fs.access(abandoned)).rejects.toThrow();
    });

    it("touches nothing but its own temp files", async () => {
      const bystanders = ["session.json.bak", "notes.txt", "salt.tmp"];
      for (const name of bystanders) {
        await leaveTempFile(name, stale);
      }

      await sessionStore.save(token);
      await sessionStore.clear();

      expect((await fs.readdir(testDir)).sort()).toEqual(
        [...bystanders, "salt"].sort()
      );
    });
  });
});
