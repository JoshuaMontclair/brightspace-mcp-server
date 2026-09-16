import { describe, it, expect } from "vitest";
import {
  parseTotpSecret,
  generateTotp,
  secondsLeftInWindow,
} from "../../src/utils/totp.js";

// RFC 6238 Appendix B reference vectors use the ASCII seed "12345678901234567890",
// which is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" in base32, with 8-digit codes.
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const rfcConfig = () => ({
  ...parseTotpSecret(RFC_SECRET_BASE32),
  digits: 8,
});

describe("generateTotp", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the RFC 6238 SHA-1 vector at T=%i", (seconds, expected) => {
    expect(generateTotp(rfcConfig(), seconds * 1000)).toBe(expected);
  });

  it("pads short codes to the configured length", () => {
    // T=1111111109 yields 7081804 before padding.
    expect(generateTotp({ ...rfcConfig(), digits: 8 }, 1111111109_000)).toMatch(
      /^0\d{7}$/
    );
  });

  it("returns 6 digits by default", () => {
    const code = generateTotp(parseTotpSecret(RFC_SECRET_BASE32), 59_000);
    expect(code).toMatch(/^\d{6}$/);
    // The 6-digit code is the tail of the 8-digit one from the same window.
    expect(code).toBe("287082");
  });

  it("holds the same code for the whole window and changes at the boundary", () => {
    const config = parseTotpSecret(RFC_SECRET_BASE32);
    expect(generateTotp(config, 30_000)).toBe(generateTotp(config, 59_999));
    expect(generateTotp(config, 60_000)).not.toBe(generateTotp(config, 59_999));
  });

  it("produces different codes per algorithm for the same window", () => {
    const sha1 = parseTotpSecret(RFC_SECRET_BASE32);
    const sha256 = { ...sha1, algorithm: "SHA256" as const };
    expect(generateTotp(sha1, 59_000)).not.toBe(generateTotp(sha256, 59_000));
  });
});

describe("parseTotpSecret", () => {
  it("parses a bare base32 secret with RFC defaults", () => {
    const config = parseTotpSecret(RFC_SECRET_BASE32);
    expect(config.digits).toBe(6);
    expect(config.period).toBe(30);
    expect(config.algorithm).toBe("SHA1");
    expect(config.secret.toString("utf-8")).toBe("12345678901234567890");
  });

  it("tolerates spaces, dashes, lowercase and padding", () => {
    const messy = ` gezd-gnbv gy3tqojq gezdgnbvgy3tqojq== `;
    expect(parseTotpSecret(messy).secret).toEqual(
      parseTotpSecret(RFC_SECRET_BASE32).secret
    );
  });

  it("parses an otpauth:// URI and keeps its label", () => {
    const config = parseTotpSecret(
      `otpauth://totp/Example:someone?secret=${RFC_SECRET_BASE32}&issuer=Example`
    );
    expect(config.secret.toString("utf-8")).toBe("12345678901234567890");
    expect(config.label).toBe("Example:someone");
    expect(config.digits).toBe(6);
    expect(config.period).toBe(30);
  });

  it("honours digits, period and algorithm from the URI", () => {
    const config = parseTotpSecret(
      `otpauth://totp/x?secret=${RFC_SECRET_BASE32}&digits=8&period=60&algorithm=SHA256`
    );
    expect(config.digits).toBe(8);
    expect(config.period).toBe(60);
    expect(config.algorithm).toBe("SHA256");
  });

  it("accepts SHA-1 spelled with a dash", () => {
    expect(
      parseTotpSecret(
        `otpauth://totp/x?secret=${RFC_SECRET_BASE32}&algorithm=SHA-1`
      ).algorithm
    ).toBe("SHA1");
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["not!base32", "base32"],
    ["otpauth://hotp/x?secret=" + RFC_SECRET_BASE32, "totp"],
    ["otpauth://totp/x?issuer=Example", "secret"],
    [`otpauth://totp/x?secret=${RFC_SECRET_BASE32}&algorithm=MD5`, "algorithm"],
    [`otpauth://totp/x?secret=${RFC_SECRET_BASE32}&digits=4`, "length"],
  ])("rejects %s", (input) => {
    expect(() => parseTotpSecret(input)).toThrow();
  });
});

describe("secondsLeftInWindow", () => {
  it("counts down to the end of the current window", () => {
    const config = parseTotpSecret(RFC_SECRET_BASE32);
    expect(secondsLeftInWindow(config, 0)).toBe(30);
    expect(secondsLeftInWindow(config, 1_000)).toBe(29);
    expect(secondsLeftInWindow(config, 29_000)).toBe(1);
    expect(secondsLeftInWindow(config, 30_000)).toBe(30);
  });

  it("respects a non-default period", () => {
    const config = { ...parseTotpSecret(RFC_SECRET_BASE32), period: 60 };
    expect(secondsLeftInWindow(config, 10_000)).toBe(50);
  });
});
