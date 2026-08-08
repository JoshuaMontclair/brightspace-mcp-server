/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import type { SSOFlow, SSOFlowConfig } from "./sso-flow.js";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * Pontificia Universidad Javeriana Cali — MobilityGuard OneGate IdP.
 *
 * Flow observed at auladigital.javerianacali.edu.co:
 *   /d2l/home  → HTML stub that JS-redirects to /d2l/login
 *   /d2l/login → 302 /d2l/lp/auth/saml/login → 302 IdP /samlv2/idp/req/any/<n>
 *              → 302 IdP /samlv2/idp/sign_in/<n>   ("Elija su método de autenticación")
 *   The chooser is a plain list of links; "Usuario y contraseña" is one GET away
 *   at /mg-local/login?type=webtoken, so we navigate there directly rather than
 *   depending on the chooser's markup.
 *
 * The credentials form keeps the typed values in decoy fields (userid /
 * not-password) and copies them into hidden inputs (uid / otp) from its own
 * submit handler. Filling the visible inputs and clicking submit runs that
 * handler, so no special handling is needed — but the values must be typed into
 * #user-id and #password, never into the hidden fields.
 */

const IDP_HOSTNAME = "mg-local.servicios.javerianacali.edu.co";

/** "Usuario y contraseña" on the authentication-method chooser. */
const CREDENTIALS_FORM_PATH = "/mg-local/login?type=webtoken";

const SELECTORS = {
  usernameInput: "input#user-id",
  passwordInput: "input#password",
  submitButton: 'form#form input[type="submit"]',
  /** OneGate's status banner. Rendered hidden and unhidden to show errors. */
  statusMessage: ".box--system-message",
} as const;

/**
 * Time allowed between submitting credentials and landing on /d2l/home.
 * Generous because OneGate may interpose a second factor (TOTP, SMS or email
 * token) that only the user can complete, in the visible browser window.
 */
const LOGIN_TIMEOUT_MS = 180_000;

/** Time allowed for a fully manual login (typing credentials + any 2FA). */
const MANUAL_LOGIN_TIMEOUT_MS = 300_000;

export class JaverianaSSOFlow implements SSOFlow {
  private config: SSOFlowConfig;

  constructor(config: SSOFlowConfig) {
    this.config = config;
  }

  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting Javeriana Cali SSO login flow (MobilityGuard OneGate)");

      await this.gotoCredentialsForm(page);
      await this.enterCredentials(page);
      this.reportStatusMessage(page);

      // A second factor may appear here. The browser is headed, so the user can
      // complete it; we just keep waiting for the post-SAML landing.
      log("INFO", "Credentials submitted — waiting for Brightspace home");
      log("INFO", "If a second factor is requested, complete it in the browser window");
      await page.waitForURL(/\/d2l\/home/, { timeout: LOGIN_TIMEOUT_MS });

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
      // Unlike Purdue's shadow-DOM campus selector, OneGate's chooser is a plain
      // list of links and is a real choice point (students use "Usuario y
      // contraseña"; staff may need another method), so leave it to the user.
      log("INFO", 'On the method chooser, students pick "Usuario y contraseña".');

      log("INFO", "Waiting up to 5 minutes for you to complete login...");
      await page.waitForURL(/\/d2l\/home/, { timeout: MANUAL_LOGIN_TIMEOUT_MS });

      log("INFO", "Manual login successful - reached Brightspace home");
      return true;
    } catch (error) {
      log("ERROR", "Manual login flow failed or timed out", error);
      return false;
    }
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
   * Get the page onto the username/password form, wherever the SAML redirect
   * chain dropped us (method chooser, or the form itself on a retry).
   */
  private async gotoCredentialsForm(page: Page): Promise<void> {
    // The redirect chain may still be in flight when we get here.
    if (new URL(page.url()).hostname !== IDP_HOSTNAME) {
      log("DEBUG", `Waiting for redirect to IdP (${IDP_HOSTNAME})`);
      await page.waitForURL((url) => url.hostname === IDP_HOSTNAME, {
        timeout: 30_000,
      });
    }

    if ((await page.locator(SELECTORS.usernameInput).count()) > 0) {
      log("DEBUG", "Already on the credentials form");
      return;
    }

    const { origin } = new URL(page.url());
    log("INFO", "Authentication-method chooser detected — opening user/password form");
    await page.goto(`${origin}${CREDENTIALS_FORM_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  private async enterCredentials(page: Page): Promise<void> {
    try {
      log("DEBUG", "Waiting for OneGate login form");
      await page.waitForSelector(SELECTORS.usernameInput, { timeout: 30_000 });

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
      await page.click(SELECTORS.submitButton);
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
