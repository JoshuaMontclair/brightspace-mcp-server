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
