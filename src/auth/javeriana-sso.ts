/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import type { SSOFlow, SSOFlowConfig } from "./sso-flow.js";
import { BrowserAuthError } from "../utils/errors.js";
import {
  generateTotp,
  parseTotpSecret,
  secondsLeftInWindow,
  MIN_VALIDITY_SECONDS,
  type TotpConfig,
} from "../utils/totp.js";
import { log } from "../utils/logger.js";

/**
 * Pontificia Universidad Javeriana Cali — MobilityGuard OneGate IdP.
 *
 * Flow observed at auladigital.javerianacali.edu.co:
 *   /d2l/home  → HTML stub that JS-redirects to /d2l/login
 *   /d2l/login → 302 /d2l/lp/auth/saml/login → 302 IdP /samlv2/idp/req/any/<n>
 *              → 302 IdP /samlv2/idp/sign_in/<n>   ("Elija su método de autenticación")
 *
 * The chooser offers three methods, each a plain link, so we GET the one that
 * matches the saved credentials instead of parsing its markup:
 *   /mg-local/login?type=webtoken  "Usuario y Contraseña"
 *   /mg-local/auth/totp            "Doble Factor Token"     ← when a TOTP secret is saved
 *   /mg-local/enigmadialog         "Doble Factor Enigma"
 *
 * The token method is two steps on one page. Both forms post to their own
 * endpoint and keep the typed values in decoy fields, copying them into hidden
 * inputs from a submit handler:
 *   #form      → POST /mg-local/auth/totp/verify      #user-id→uid, #password→otp
 *   #otp-form  → POST /mg-local/auth/totp/verify/otp  #token→token
 * Submitting the first reveals the second on /auth/totp/verify. Because the
 * handler does the copying, the values must be typed into the visible fields
 * and submitted by clicking that form's own button — never written to the
 * hidden inputs directly.
 *
 * #token is rendered visible but disabled from the very first paint, so
 * visibility says nothing about whether step 1 has happened. Being editable is
 * the only honest signal that the code is being asked for.
 *
 * The submit handler is wired up on load, not on DOMContentLoaded. Submitting
 * before then posts the form natively with the hidden fields still empty:
 * OneGate accepts the POST, renders /auth/totp/verify, and leaves the code
 * field disabled forever. Hence the wait for a fully loaded document before
 * touching either form.
 */

const IDP_HOSTNAME = "mg-local.servicios.javerianacali.edu.co";

/** "Usuario y Contraseña" — used when no TOTP secret is saved. */
const CREDENTIALS_FORM_PATH = "/mg-local/login?type=webtoken";

/** "Doble Factor Token" — username, password and authenticator code. */
const TOTP_FORM_PATH = "/mg-local/auth/totp";

/** Covers both /auth/totp and the /auth/totp/verify step. */
const TOTP_PATH_PATTERN = /\/auth\/totp/i;

const SELECTORS = {
  usernameInput: "input#user-id",
  passwordInput: "input#password",
  tokenInput: "input#token",
  credentialsSubmit: 'form#form input[type="submit"]',
  tokenSubmit: 'form#otp-form input[type="submit"]',
  /** OneGate's status banner. Rendered hidden and unhidden to show errors. */
  statusMessage: ".box--system-message",
} as const;

/**
 * Time allowed for the whole login. Generous because OneGate may interpose a
 * step that only the user can complete, in the visible browser window.
 */
const LOGIN_TIMEOUT_MS = 180_000;

/** Time allowed for a fully manual login (typing credentials + any 2FA). */
const MANUAL_LOGIN_TIMEOUT_MS = 300_000;

/** Time allowed for step 1's POST to reveal the code field. */
const TOKEN_REVEAL_TIMEOUT_MS = 30_000;

/** Time allowed for the SAML hop-chain that follows an accepted code. */
const TOKEN_SUBMIT_TIMEOUT_MS = 30_000;

/**
 * A rejected code re-renders the form, so one retry covers the realistic
 * failure (the window rolled over mid-submit) without racing the account
 * lockout that more attempts would risk.
 */
const TOKEN_ATTEMPTS = 2;

/**
 * Stages share one budget rather than each getting its own timeout, so a login
 * that stalls fails within LOGIN_TIMEOUT_MS instead of once per stage. The
 * floor keeps the last stage from being handed a zero-length wait.
 */
function remaining(deadline: number): number {
  return Math.max(5_000, deadline - Date.now());
}

export class JaverianaSSOFlow implements SSOFlow {
  private config: SSOFlowConfig;
  private totp: TotpConfig | null;

  constructor(config: SSOFlowConfig) {
    this.config = config;
    this.totp = this.parseTotpConfig(config.totpSecret);
  }

  /**
   * A malformed secret must not be fatal: the browser is headed, so degrading
   * to "type the code yourself" still logs the user in, while throwing here
   * would break a login that used to work.
   */
  private parseTotpConfig(secret?: string): TotpConfig | null {
    if (!secret) return null;
    try {
      const parsed = parseTotpSecret(secret);
      log(
        "DEBUG",
        `TOTP configured${parsed.label ? ` for ${parsed.label}` : ""} ` +
          `(${parsed.digits} digits, ${parsed.period}s, ${parsed.algorithm})`
      );
      return parsed;
    } catch (error) {
      log(
        "WARN",
        `Saved TOTP secret could not be read (${
          error instanceof Error ? error.message : String(error)
        }) — you will need to type the code yourself. Re-run setup to fix it.`
      );
      return null;
    }
  }

  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  /**
   * OneGate wants the code typed into the page, so without a readable secret
   * there is nothing to type and someone has to watch the window.
   */
  canRunUnattended(): boolean {
    return this.hasCredentials() && this.totp !== null;
  }

  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting Javeriana Cali SSO login flow (MobilityGuard OneGate)");
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;

      await this.gotoLoginForm(page);
      await this.enterCredentials(page);
      this.reportStatusMessage(page);

      if (this.totp) {
        await this.enterToken(page, deadline);
      } else {
        log(
          "INFO",
          "If OneGate asks for a second factor, complete it in the browser window"
        );
      }

      log("INFO", "Waiting for Brightspace home");
      await page.waitForURL(/\/d2l\/home/, { timeout: remaining(deadline) });

      log("INFO", "Login successful - reached Brightspace home");
      return true;
    } catch (error) {
      log("ERROR", "Javeriana SSO login flow failed", error);
      return false;
    }
  }

  async manualLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting manual login flow (no saved credentials)");
      log("INFO", "Please log in using the browser window that just opened.");
      // OneGate's chooser is a real choice point (students use "Usuario y
      // Contraseña" or "Doble Factor Token"; staff may need another method),
      // so leave the pick to the user.
      log("INFO", "Waiting up to 5 minutes for you to complete login...");

      const deadline = Date.now() + MANUAL_LOGIN_TIMEOUT_MS;

      // A saved secret is still worth using here: the user types their own
      // password, and enterToken returns early if they never reach the code
      // step, so it costs nothing when they pick another method.
      if (this.totp) await this.enterToken(page, deadline);

      await page.waitForURL(/\/d2l\/home/, { timeout: remaining(deadline) });

      log("INFO", "Manual login successful - reached Brightspace home");
      return true;
    } catch (error) {
      log("ERROR", "Manual login flow failed or timed out", error);
      return false;
    }
  }

  /**
   * Fill the authenticator code once step 1 reveals it.
   *
   * Never throws: the caller's wait for /d2l/home is what decides success, and
   * leaving the headed browser on the code page lets the user finish by hand
   * from any state this gives up in.
   */
  private async enterToken(page: Page, deadline: number): Promise<void> {
    if (!this.totp) return;

    for (let attempt = 1; attempt <= TOKEN_ATTEMPTS; attempt++) {
      const revealed = await this.waitForTokenField(page, deadline);
      if (!revealed) return;

      // The code field is enabled while /auth/totp/verify is still loading, so
      // being editable does not mean #otp-form's handler is wired up yet. Same
      // trap as the credentials form: an early click posts an empty token.
      await page.waitForLoadState("load");

      // Never submit a code that is about to roll over: OneGate would reject
      // it on arrival, and that burns one of the few attempts the account has.
      const secondsLeft = secondsLeftInWindow(this.totp);
      if (secondsLeft < MIN_VALIDITY_SECONDS) {
        log("DEBUG", `Code window rolls over in ${secondsLeft}s — waiting for the next one`);
        await page.waitForTimeout((secondsLeft + 1) * 1000);
      }

      log("INFO", `Entering authenticator code (attempt ${attempt}/${TOKEN_ATTEMPTS})`);
      await page.fill(SELECTORS.tokenInput, generateTotp(this.totp));
      await page.locator(SELECTORS.tokenSubmit).first().click();

      // Leaving /auth/totp at all means the code was accepted; a rejected one
      // re-renders the same path, so the predicate simply never fires.
      const accepted = await page
        .waitForURL((url) => !TOTP_PATH_PATTERN.test(url.pathname), {
          timeout: Math.min(TOKEN_SUBMIT_TIMEOUT_MS, remaining(deadline)),
        })
        .then(() => true)
        .catch(() => false);

      if (accepted) {
        log("INFO", "Authenticator code accepted");
        return;
      }

      log(
        "WARN",
        attempt < TOKEN_ATTEMPTS
          ? "Code was not accepted — retrying with the next one"
          : "Code was not accepted. Check that your device clock is correct, " +
            "then enter a code in the browser window."
      );
    }
  }

  /**
   * Wait for the code field to become editable, or for the login to finish
   * without one — the user may have picked another method, or OneGate may
   * trust the session already.
   *
   * Editability rather than visibility: the field is on the page, visible and
   * disabled, before step 1 is submitted, so waiting for it to appear returns
   * instantly and fills a field the page is still ignoring.
   */
  private async waitForTokenField(page: Page, deadline: number): Promise<boolean> {
    const timeout = Math.min(TOKEN_REVEAL_TIMEOUT_MS, remaining(deadline));

    const outcome = await Promise.race([
      page
        .waitForFunction(
          (selector) => {
            const el = document.querySelector(selector) as HTMLInputElement | null;
            return (
              !!el &&
              !el.disabled &&
              !el.readOnly &&
              !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
            );
          },
          SELECTORS.tokenInput,
          { timeout }
        )
        .then(() => "token" as const)
        .catch(() => "none" as const),
      page
        .waitForURL(/\/d2l\/home/, { timeout })
        .then(() => "home" as const)
        .catch(() => "none" as const),
    ]);

    if (outcome === "home") {
      log("DEBUG", "Reached Brightspace without being asked for a code");
    } else if (outcome === "none") {
      log(
        "WARN",
        "OneGate never asked for the authenticator code — check the browser window"
      );
    }
    return outcome === "token";
  }

  /**
   * Surface OneGate's status banner (wrong password, locked account, ...) in the
   * logs if it appears. Deliberately non-blocking and advisory: the banner is
   * also used for harmless notices, so it must not abort a login that is still
   * progressing — it only explains a wait that is about to time out.
   */
  private reportStatusMessage(page: Page): void {
    page
      .waitForSelector(SELECTORS.statusMessage, {
        state: "visible",
        timeout: LOGIN_TIMEOUT_MS,
      })
      .then(async (handle) => {
        const text = (await handle.textContent())?.trim();
        if (text) log("WARN", `OneGate reported: ${text}`);
      })
      .catch(() => {
        // No banner, or the page navigated away first — both are expected.
      });
  }

  /**
   * Get the page onto the login form for the method we can actually complete,
   * wherever the SAML redirect chain dropped us (chooser, or a form already).
   */
  private async gotoLoginForm(page: Page): Promise<void> {
    // The redirect chain may still be in flight when we get here.
    if (new URL(page.url()).hostname !== IDP_HOSTNAME) {
      log("DEBUG", `Waiting for redirect to IdP (${IDP_HOSTNAME})`);
      await page.waitForURL((url) => url.hostname === IDP_HOSTNAME, {
        timeout: 30_000,
      });
    }

    // #token exists only on the token form, so it tells the two forms apart.
    const hasTokenField = (await page.locator(SELECTORS.tokenInput).count()) > 0;
    const hasUsernameField = (await page.locator(SELECTORS.usernameInput).count()) > 0;
    const alreadyThere = this.totp ? hasTokenField : hasUsernameField && !hasTokenField;
    if (alreadyThere) {
      log("DEBUG", "Already on the expected login form");
      return;
    }

    const { origin } = new URL(page.url());
    const formPath = this.totp ? TOTP_FORM_PATH : CREDENTIALS_FORM_PATH;
    log(
      "INFO",
      this.totp
        ? 'Opening the "Doble Factor Token" form'
        : 'Opening the "Usuario y Contraseña" form'
    );
    await page.goto(`${origin}${formPath}`, {
      waitUntil: "load",
      timeout: 30_000,
    });
  }

  private async enterCredentials(page: Page): Promise<void> {
    try {
      log("DEBUG", "Waiting for OneGate login form");
      await page.waitForSelector(SELECTORS.usernameInput, { timeout: 30_000 });

      // Not redundant with the navigation above: when the SAML chain drops us
      // straight onto a form, there is no goto of ours to have waited on, and
      // clicking submit before load silently posts empty hidden fields.
      await page.waitForLoadState("load");

      if (!this.config.username) {
        throw new BrowserAuthError(
          "Username is required for SSO login",
          "credentials"
        );
      }

      if (!this.config.password) {
        throw new BrowserAuthError(
          "Password is required for SSO login",
          "credentials"
        );
      }

      log("INFO", "Entering credentials");
      await page.fill(SELECTORS.usernameInput, this.config.username);
      await page.fill(SELECTORS.passwordInput, this.config.password);
      await page.locator(SELECTORS.credentialsSubmit).first().click();
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new BrowserAuthError(
        "Failed to enter credentials",
        "credentials",
        error as Error
      );
    }
  }
}
