import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// config-store resolves CONFIG_DIR from os.homedir() once, at import time, so the
// only way to keep these tests off the real ~/.brightspace-mcp is to hand the
// module a throwaway home before it loads. That directory holds the developer's
// actual Brightspace password and TOTP secret; a test must never read,
// overwrite or delete it.
//
// The "config-store-test-" prefix is load-bearing, not decoration: assertDisposable
// below refuses to delete anything that does not carry it. Keep the two in step.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const nodePath = await import("node:path");
  const home = nodePath.join(
    actual.tmpdir(),
    `config-store-test-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`
  );
  const homedir = () => home;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import {
  configStoreExists,
  getConfigStorePath,
  loadConfigStore,
  saveConfigStore,
  type ConfigStoreData,
} from "../../src/utils/config-store.js";

const FAKE_HOME = os.homedir();
const CONFIG_DIR = path.join(FAKE_HOME, ".brightspace-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// tmpdir() is never mocked — the factory above spreads it straight from the real
// module — so it is a trustworthy anchor even in the world where homedir() is not.
const REAL_TMPDIR = os.tmpdir();
const TEST_HOME_PREFIX = "config-store-test-";

/**
 * Gate every destructive call in this file. FAKE_HOME and CONFIG_DIR come from a
 * mocked os.homedir(); if that mock ever stops applying — a vitest upgrade, a pool
 * or isolation change, a different import specifier in config-store — they silently
 * become the developer's real home, and an rm -rf there costs far more than the
 * truncated-config bug these tests exist to pin down. The assertion in beforeEach
 * does not cover that, because vitest still runs afterEach and afterAll after a
 * beforeEach throws. So the teardown refuses rather than deletes: the path must sit
 * under the real tmpdir, inside a directory this file named itself.
 */
function assertDisposable(target: string): string {
  const root = path.resolve(REAL_TMPDIR);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  const [firstSegment] = relative.split(path.sep);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !firstSegment.startsWith(TEST_HOME_PREFIX)
  ) {
    throw new Error(
      `refusing to touch ${resolved}: it is not a throwaway ${TEST_HOME_PREFIX}* ` +
        `directory under ${root}. The node:os mock did not take, so this would ` +
        `have hit the developer's real home.`
    );
  }
  return resolved;
}

/** rm -rf, but only ever inside this run's throwaway home. */
function removeDisposable(target: string): void {
  fs.rmSync(assertDisposable(target), { recursive: true, force: true });
}

describe("config store", () => {
  // chmod is a no-op on Windows and file modes are not POSIX there, so the tests
  // that hinge on either are Unix-only rather than silently vacuous. Root
  // bypasses mode checks outright, so the tests that need a write to actually be
  // refused skip there too instead of failing.
  const isRoot = process.getuid !== undefined && process.getuid() === 0;
  const unixOnly = process.platform === "win32" ? it.skip : it;
  const unprivilegedUnixOnly =
    process.platform === "win32" || isRoot ? it.skip : it;

  const sample: ConfigStoreData = {
    baseUrl: "https://brightspace.example.edu",
    username: "student@example.edu",
    password: "correct horse battery staple",
    totpSecret: "JBSWY3DPEHPK3PXP",
    tokenTtl: 3600,
    headless: true,
    includeCourses: [101, 202],
    activeOnly: false,
  };

  /** Everything in the config dir that is not the config file itself. */
  function strayFiles(): string[] {
    return fs
      .readdirSync(CONFIG_DIR)
      .filter((entry) => entry !== "config.json")
      .sort();
  }

  beforeEach(() => {
    // Refuse to run at all if the os mock did not take: without this the whole
    // suite would operate on the developer's real credentials.
    expect(getConfigStorePath().startsWith(os.tmpdir())).toBe(true);
    expect(getConfigStorePath()).toBe(CONFIG_FILE);

    removeDisposable(CONFIG_DIR);
  });

  afterEach(() => {
    // A failed test may have left the directory unwritable; make it removable.
    if (process.platform !== "win32" && fs.existsSync(CONFIG_DIR)) {
      fs.chmodSync(assertDisposable(CONFIG_DIR), 0o700);
    }
    removeDisposable(CONFIG_DIR);
  });

  afterAll(() => {
    removeDisposable(FAKE_HOME);
  });

  describe("teardown safety net", () => {
    it("accepts this run's throwaway home", () => {
      expect(() => assertDisposable(FAKE_HOME)).not.toThrow();
      expect(() => assertDisposable(CONFIG_FILE)).not.toThrow();
    });

    it("refuses the paths an unmocked os.homedir() would produce", () => {
      // The exact values the hooks would have been handed had vi.mock not applied.
      const realHome = path.join("/Users", "someone");
      expect(() => assertDisposable(realHome)).toThrow(/refusing to touch/);
      expect(() =>
        assertDisposable(path.join(realHome, ".brightspace-mcp"))
      ).toThrow(/refusing to touch/);
      // And nothing may take out the shared tmpdir itself, or escape upwards.
      expect(() => assertDisposable(REAL_TMPDIR)).toThrow(/refusing to touch/);
      expect(() =>
        assertDisposable(path.join(REAL_TMPDIR, "someone-elses-fixtures"))
      ).toThrow(/refusing to touch/);
      expect(() =>
        assertDisposable(path.join(FAKE_HOME, "..", "..", "etc"))
      ).toThrow(/refusing to touch/);
    });
  });

  describe("save and load", () => {
    it("save then load returns the same config", () => {
      saveConfigStore(sample);

      expect(loadConfigStore()).toEqual(sample);
    });

    it("creates the config directory on the first save", () => {
      expect(fs.existsSync(CONFIG_DIR)).toBe(false);

      saveConfigStore(sample);

      expect(fs.existsSync(CONFIG_FILE)).toBe(true);
    });

    it("replaces an existing config rather than appending to it", () => {
      saveConfigStore(sample);
      const replacement: ConfigStoreData = { username: "someone-else" };
      saveConfigStore(replacement);

      expect(loadConfigStore()).toEqual(replacement);
      // A rename over the target, not a write into the open file: a shorter
      // config must not leave the tail of the longer one behind.
      expect(fs.readFileSync(CONFIG_FILE, "utf-8")).toBe(
        JSON.stringify(replacement, null, 2) + "\n"
      );
    });
  });

  describe("configStoreExists", () => {
    it("is false before anything is saved", () => {
      expect(configStoreExists()).toBe(false);
    });

    it("is false when only the config directory exists", () => {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });

      expect(configStoreExists()).toBe(false);
    });

    it("is true once a config has been saved", () => {
      saveConfigStore(sample);

      expect(configStoreExists()).toBe(true);
    });
  });

  describe("atomic save", () => {
    it("leaves no temp file behind after a successful save", () => {
      saveConfigStore(sample);

      expect(strayFiles()).toEqual([]);
    });

    it("leaves no temp file behind when the write cannot be committed", () => {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      // A directory where the config file belongs: the temp file is written and
      // only the rename fails, which exercises the cleanup path rather than the
      // cheaper case where nothing was ever created.
      fs.mkdirSync(CONFIG_FILE);

      expect(() => saveConfigStore(sample)).toThrow();

      expect(strayFiles()).toEqual([]);
    });

    unixOnly("saves the config file with owner-only permissions", () => {
      saveConfigStore(sample);

      // The rename preserves the temp file's mode, so this also shows the temp
      // file was created 0600 rather than widened and chmod'd afterwards.
      expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
    });

    unixOnly("creates the config directory with owner-only permissions", () => {
      saveConfigStore(sample);

      expect(fs.statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
    });

    unprivilegedUnixOnly(
      "keeps the previous config intact and loadable when a save fails",
      () => {
        saveConfigStore(sample);

        // Read-only config dir: the save fails with good credentials already on
        // disk, which is exactly the crash-mid-write this change exists to
        // survive.
        fs.chmodSync(CONFIG_DIR, 0o500);
        try {
          expect(() =>
            saveConfigStore({ ...sample, password: "replacement" })
          ).toThrow();
        } finally {
          fs.chmodSync(CONFIG_DIR, 0o700);
        }

        expect(loadConfigStore()).toEqual(sample);
        expect(strayFiles()).toEqual([]);
      }
    );

    unprivilegedUnixOnly(
      "leaves the config file untouched when the temp file cannot be created",
      () => {
        saveConfigStore(sample);
        const before = fs.readFileSync(CONFIG_FILE, "utf-8");

        fs.chmodSync(CONFIG_DIR, 0o500);
        try {
          expect(() => saveConfigStore({ username: "clobbered" })).toThrow();
        } finally {
          fs.chmodSync(CONFIG_DIR, 0o700);
        }

        // Not merely loadable: byte-for-byte what was there, so a truncating
        // write would be caught even if it happened to leave valid JSON.
        expect(fs.readFileSync(CONFIG_FILE, "utf-8")).toBe(before);
      }
    );
  });
});
