/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";

/**
 * Contract every school's login flow must satisfy.
 *
 * BrowserAuth drives the browser and extracts the API token; a flow is only
 * responsible for getting the page from "redirected to the IdP" to
 * "landed back on /d2l/home".
 */
export interface SSOFlow {
  /** True when saved credentials are available for an automated login. */
  hasCredentials(): boolean;

  /** Automated login using saved credentials. Returns false on failure. */
  login(page: Page): Promise<boolean>;

  /** Headed fallback: the user types credentials themselves. */
  manualLogin(page: Page): Promise<boolean>;
}

export interface SSOFlowConfig {
  baseUrl: string;
  username?: string;
  password?: string;
}
