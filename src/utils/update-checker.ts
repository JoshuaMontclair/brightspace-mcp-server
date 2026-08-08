/**
 * Background npm update checker — non-blocking fetch on startup.
 * Compares installed version against latest on npm registry.
 * If a newer version exists, auto-updates (clears npx cache or
 * runs npm install -g) so the next launch picks up the new version.
 */

import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..", "..");

let notice: string | null = null;

function getInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isNpxCache(): boolean {
  const normalized = projectRoot.split(sep).join("/");
  return /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]brightspace-mcp-server/.test(normalized);
}

async function clearAllNpxCaches(): Promise<number> {
  const { homedir } = await import("node:os");
  const npxCacheRoot = resolve(homedir(), ".npm", "_npx");
  const { readdir } = await import("node:fs/promises");

  let cleared = 0;
  try {
    const entries = await readdir(npxCacheRoot);
    for (const entry of entries) {
      const pkgPath = resolve(npxCacheRoot, entry, "node_modules", "brightspace-mcp-server");
      try {
        const { access } = await import("node:fs/promises");
        await access(pkgPath);
        await rm(resolve(npxCacheRoot, entry), { recursive: true, force: true });
        cleared++;
      } catch {
        // Not a brightspace cache entry, skip
      }
    }
  } catch {
    // npx cache dir doesn't exist or not readable
  }
  return cleared;
}

/**
 * True when `candidate` is a strictly newer release than `current`.
 *
 * An inequality check is not enough: anyone running a local build ahead of npm
 * (a fork, or a release not published yet) would otherwise be "updated"
 * backwards to the published version on every start.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const FALLBACK_MSG = (old: string, latest: string) =>
  `Update available: v${old} → v${latest}. ` +
  "Run `npx brightspace-mcp-server@latest` or clear your npx cache to update.";

export function initUpdateChecker(): void {
  const installed = getInstalledVersion();

  exec("npm view brightspace-mcp-server version", { timeout: 10000 }, (err, stdout) => {
    if (err) return;
    const latest = stdout.trim();
    if (!latest || !isNewerVersion(latest, installed)) return;

    if (isNpxCache()) {
      clearAllNpxCaches()
        .then((count) => {
          notice =
            `Auto-updated: cleared ${count} npx cache(s) (v${installed} → v${latest}). ` +
            "The new version will be downloaded on next restart.";
        })
        .catch(() => {
          notice = FALLBACK_MSG(installed, latest);
        });
    } else {
      exec("npm install -g brightspace-mcp-server@latest", { timeout: 60000 }, (installErr) => {
        if (installErr) {
          notice = FALLBACK_MSG(installed, latest);
        } else {
          notice =
            `Auto-updated from v${installed} to v${latest}. ` +
            "Restart your MCP client to use the new version.";
        }
      });
    }
  });
}

export function getUpdateNotice(): string | null {
  const result = notice;
  notice = null;
  return result;
}
