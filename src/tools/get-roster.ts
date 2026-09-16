/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS, fetchAllObjects } from "../api/index.js";
import {
  GetRosterSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface ClasslistUser {
  Identifier: number;
  DisplayName: string;
  Email: string | null;
  FirstName: string | null;
  LastName: string | null;
  RoleId: number | null;
  ClasslistRoleDisplayName: string;
  IsOnline: boolean;
  LastAccessed: string | null;
}

// Purdue-specific role IDs. These are institution-specific values.
// If using at another institution, you may need to adjust these.
// Discover by fetching classlist for a known course and inspecting RoleId values.
const INSTRUCTOR_ROLE_ID = 109;
const TA_ROLE_ID = 135;

// A whole classlist can be thousands of people, which no MCP client wants in
// one response. The cap is deliberate and only applies to the includeStudents
// path; it is reported in the logs rather than applied quietly.
const MAX_STUDENTS_RETURNED = 100;

/**
 * Fetch classlist users matching the optional filters, walking pages until the
 * endpoint runs out of them or maxItems is reached.
 */
async function fetchClasslistUsers(
  apiClient: D2LApiClient,
  courseId: number,
  options?: { roleId?: number; searchTerm?: string; maxItems?: number }
): Promise<ClasslistUser[]> {
  const params = new URLSearchParams();

  if (options?.roleId !== undefined) {
    params.append("roleId", options.roleId.toString());
  }

  if (options?.searchTerm) {
    params.append("searchTerm", options.searchTerm);
  }

  const queryString = params.toString();
  const path = apiClient.le(
    courseId,
    `/classlist/paged/${queryString ? "?" + queryString : ""}`
  );

  return fetchAllObjects<ClasslistUser>(apiClient, path, {
    ttl: DEFAULT_CACHE_TTLS.roster,
    maxItems: options?.maxItems,
  });
}

/**
 * Register get_roster tool
 */
export function registerGetRoster(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_roster",
    {
      title: "Get Course Roster",
      description:
        "Fetch the roster for a course including instructors, TAs, and optionally students with their names, emails, and roles. Use this when the user asks about classmates, instructor contact info, TA emails, professor names, or who's in a class. By default returns only instructors and TAs for privacy. Use includeStudents to get full class list.",
      inputSchema: GetRosterSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_roster tool called", { args });

        // Parse and validate input
        const { courseId, includeStudents, searchTerm } = GetRosterSchema.parse(args);

        let allUsers: ClasslistUser[] = [];

        if (!includeStudents) {
          // Fetch instructors and TAs in parallel
          const [instructorResult, taResult] = await Promise.allSettled([
            fetchClasslistUsers(apiClient, courseId, {
              roleId: INSTRUCTOR_ROLE_ID,
              searchTerm,
            }),
            fetchClasslistUsers(apiClient, courseId, {
              roleId: TA_ROLE_ID,
              searchTerm,
            }),
          ]);

          // Merge results
          if (instructorResult.status === "fulfilled") {
            allUsers.push(...instructorResult.value);
          } else {
            log("WARN", "get_roster: Failed to fetch instructors", {
              error: instructorResult.reason,
            });
          }

          if (taResult.status === "fulfilled") {
            allUsers.push(...taResult.value);
          } else {
            log("WARN", "get_roster: Failed to fetch TAs", {
              error: taResult.reason,
            });
          }
        } else {
          // One item past the cap, not the whole classlist. Everything beyond
          // MAX_STUDENTS_RETURNED is discarded below, and a 900-student lecture
          // would otherwise spend eight extra serial round trips — rate-limit
          // budget shared with every other tool, and eight more chances for a
          // 429 to fail a roster the first page had already answered.
          allUsers = await fetchClasslistUsers(apiClient, courseId, {
            searchTerm,
            maxItems: MAX_STUDENTS_RETURNED + 1,
          });

          // Stopping one past the cap is what keeps this notice honest: the
          // exact enrollment total is no longer known, but "more than the cap"
          // still is, which is all the truncation claims.
          if (allUsers.length > MAX_STUDENTS_RETURNED) {
            log(
              "WARN",
              `get_roster: More than ${MAX_STUDENTS_RETURNED} users in the classlist, truncating`,
              {
                courseId,
                returned: MAX_STUDENTS_RETURNED,
              }
            );
            allUsers = allUsers.slice(0, MAX_STUDENTS_RETURNED);
          }
        }

        // Map to clean output
        const roster = allUsers.map((user) => ({
          name: user.DisplayName,
          email: user.Email || null,
          role: user.ClasslistRoleDisplayName,
        }));

        log("INFO", `get_roster: Retrieved ${roster.length} users for course ${courseId}`);
        return toolResponse(roster);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
