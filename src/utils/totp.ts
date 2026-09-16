/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createHmac } from "node:crypto";

/**
 * RFC 6238 TOTP, so a school whose second factor is an authenticator app can
 * be logged into unattended.
 *
 * Implemented here instead of pulled in as a dependency: it is a HMAC and a
 * modulo, and this package asks students to hand it their credentials, so
 * every line that touches a secret should be readable in this repo.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpConfig {
  /** Shared secret, already decoded from base32. */
  secret: Buffer;
  digits: number;
  /** Window length in seconds. */
  period: number;
  algorithm: TotpAlgorithm;
  /** Account label from an otpauth:// URI. Never holds the secret. */
  label?: string;
}

/**
 * Submitting a code in the last moments of its window burns a login attempt
 * for nothing, so callers wait for the next one instead.
 */
export const MIN_VALIDITY_SECONDS = 3;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 decode. Tolerates spaces, dashes and missing padding. */
function base32Decode(input: string): Buffer {
  const cleaned = input
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "")
    .toUpperCase();

  if (!cleaned) throw new Error("The TOTP secret is empty.");

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(
        `The TOTP secret is not valid base32 (unexpected character "${char}").`
      );
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  // Trailing bits that do not complete a byte are padding, per RFC 4648.
  if (bytes.length === 0) {
    throw new Error("The TOTP secret is too short to be a valid key.");
  }

  return Buffer.from(bytes);
}

function readIntParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`The otpauth:// URI has a non-numeric "${name}" value.`);
  }
  return parsed;
}

function parseOtpauthUri(uri: string): TotpConfig {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("Could not parse the otpauth:// URI.");
  }

  const type = url.hostname.toLowerCase();
  if (type && type !== "totp") {
    throw new Error(
      `Only time-based (totp) URIs are supported, but this one is "${type}".`
    );
  }

  const secret = url.searchParams.get("secret");
  if (!secret) {
    throw new Error('The otpauth:// URI has no "secret" parameter.');
  }

  const digits = readIntParam(url, "digits", 6);
  if (digits < 6 || digits > 10) {
    throw new Error(`Unsupported TOTP code length: ${digits} digits.`);
  }

  const period = readIntParam(url, "period", 30);
  if (period < 1) {
    throw new Error(`Unsupported TOTP period: ${period} seconds.`);
  }

  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1")
    .toUpperCase()
    .replace(/-/g, "");
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") {
    throw new Error(`Unsupported TOTP algorithm "${algorithm}".`);
  }

  let label: string | undefined;
  try {
    label = decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined;
  } catch {
    label = url.pathname.replace(/^\//, "") || undefined;
  }

  return { secret: base32Decode(secret), digits, period, algorithm, label };
}

/**
 * Accept whatever form the school handed the user: the full `otpauth://` URI
 * behind the enrollment QR code, or the bare base32 secret printed next to it.
 */
export function parseTotpSecret(input: string): TotpConfig {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("The TOTP secret is empty.");

  if (/^otpauth:\/\//i.test(trimmed)) return parseOtpauthUri(trimmed);

  return {
    secret: base32Decode(trimmed),
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  };
}

/** The code valid at `atMs`, zero-padded to `config.digits`. */
export function generateTotp(config: TotpConfig, atMs: number = Date.now()): string {
  const counter = BigInt(Math.floor(atMs / 1000 / config.period));

  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac(config.algorithm.toLowerCase(), config.secret)
    .update(counterBytes)
    .digest();

  // Dynamic truncation (RFC 4226 §5.4): the low nibble of the last byte picks
  // the 4-byte window, whose high bit is masked off to stay sign-agnostic.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** config.digits).padStart(config.digits, "0");
}

/** Seconds the code generated at `atMs` stays valid. */
export function secondsLeftInWindow(
  config: TotpConfig,
  atMs: number = Date.now()
): number {
  return config.period - (Math.floor(atMs / 1000) % config.period);
}
