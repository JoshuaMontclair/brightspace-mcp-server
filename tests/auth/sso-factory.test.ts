import { describe, it, expect } from "vitest";
import { createSSOFlow } from "../../src/auth/sso-factory.js";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { JaverianaSSOFlow } from "../../src/auth/javeriana-sso.js";

describe("createSSOFlow", () => {
  it("routes Purdue to the Purdue flow", () => {
    const flow = createSSOFlow({ baseUrl: "https://purdue.brightspace.com" });
    expect(flow).toBeInstanceOf(PurdueSSOFlow);
  });

  it("routes Javeriana Cali to the Javeriana flow", () => {
    const flow = createSSOFlow({
      baseUrl: "https://auladigital.javerianacali.edu.co",
    });
    expect(flow).toBeInstanceOf(JaverianaSSOFlow);
  });

  it("matches on hostname regardless of case, path or trailing slash", () => {
    for (const baseUrl of [
      "https://AULADIGITAL.JaverianaCali.edu.co",
      "https://auladigital.javerianacali.edu.co/",
      "https://auladigital.javerianacali.edu.co/d2l/home",
    ]) {
      expect(createSSOFlow({ baseUrl })).toBeInstanceOf(JaverianaSSOFlow);
    }
  });

  it("falls back to the Purdue flow for unregistered hosts", () => {
    const flow = createSSOFlow({ baseUrl: "https://myuni.brightspace.com" });
    expect(flow).toBeInstanceOf(PurdueSSOFlow);
  });

  it("does not throw on a malformed baseUrl", () => {
    expect(() => createSSOFlow({ baseUrl: "not a url" })).not.toThrow();
  });

  it("does not throw on an unreadable TOTP secret", () => {
    // A typo in the saved secret must degrade to "type the code yourself",
    // never break a login that would otherwise work.
    expect(() =>
      createSSOFlow({
        baseUrl: "https://auladigital.javerianacali.edu.co",
        username: "u",
        password: "p",
        totpSecret: "not!a!valid!secret",
      })
    ).not.toThrow();
  });

  describe("canRunUnattended", () => {
    const javeriana = "https://auladigital.javerianacali.edu.co";
    const validSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    it("is false for Javeriana without a TOTP secret", () => {
      // OneGate wants the code typed into the page, so someone has to watch.
      expect(
        createSSOFlow({ baseUrl: javeriana, username: "u", password: "p" })
          .canRunUnattended()
      ).toBe(false);
    });

    it("is true for Javeriana with credentials and a TOTP secret", () => {
      expect(
        createSSOFlow({
          baseUrl: javeriana,
          username: "u",
          password: "p",
          totpSecret: validSecret,
        }).canRunUnattended()
      ).toBe(true);
    });

    it("is false for Javeriana when the TOTP secret is unreadable", () => {
      // Degrading to a visible window beats hiding a login nobody can finish.
      expect(
        createSSOFlow({
          baseUrl: javeriana,
          username: "u",
          password: "p",
          totpSecret: "not!a!secret",
        }).canRunUnattended()
      ).toBe(false);
    });

    it("is false without credentials, secret or not", () => {
      expect(
        createSSOFlow({ baseUrl: javeriana, totpSecret: validSecret })
          .canRunUnattended()
      ).toBe(false);
    });

    it("needs only credentials at Purdue, where Duo is approved on the phone", () => {
      const baseUrl = "https://purdue.brightspace.com";
      expect(createSSOFlow({ baseUrl, username: "u", password: "p" }).canRunUnattended()).toBe(true);
      expect(createSSOFlow({ baseUrl, username: "u" }).canRunUnattended()).toBe(false);
    });
  });

  it("reports credentials only when both username and password are set", () => {
    const baseUrl = "https://auladigital.javerianacali.edu.co";
    expect(createSSOFlow({ baseUrl }).hasCredentials()).toBe(false);
    expect(createSSOFlow({ baseUrl, username: "u" }).hasCredentials()).toBe(false);
    expect(createSSOFlow({ baseUrl, password: "p" }).hasCredentials()).toBe(false);
    expect(
      createSSOFlow({ baseUrl, username: "u", password: "p" }).hasCredentials()
    ).toBe(true);
  });
});
