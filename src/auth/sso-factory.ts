/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { SSOFlow, SSOFlowConfig } from "./sso-flow.js";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { JaverianaSSOFlow } from "./javeriana-sso.js";
import { log } from "../utils/logger.js";

type SSOFlowFactory = (config: SSOFlowConfig) => SSOFlow;

/**
 * Brightspace hostname → login flow.
 *
 * Every school fronts Brightspace with its own IdP, so the login steps are
 * per-school even though everything after /d2l/home is identical. To add a
 * school: implement SSOFlow in a new file here and register its hostname.
 */
const FLOWS_BY_HOSTNAME: Record<string, SSOFlowFactory> = {
  "purdue.brightspace.com": (config) => new PurdueSSOFlow(config),
  "auladigital.javerianacali.edu.co": (config) => new JaverianaSSOFlow(config),
};

/**
 * Pick the login flow matching the configured Brightspace instance.
 * Falls back to the Purdue flow for unrecognized hosts.
 */
export function createSSOFlow(config: SSOFlowConfig): SSOFlow {
  let hostname: string;
  try {
    hostname = new URL(config.baseUrl).hostname.toLowerCase();
  } catch {
    hostname = "";
  }

  const factory = FLOWS_BY_HOSTNAME[hostname];
  if (factory) {
    log("DEBUG", `Using SSO flow registered for ${hostname}`);
    return factory(config);
  }

  log(
    "WARN",
    `No SSO flow registered for ${hostname || config.baseUrl} — falling back to the Purdue flow. ` +
      "If login fails, clear the saved password so the browser opens for manual login."
  );
  return new PurdueSSOFlow(config);
}
