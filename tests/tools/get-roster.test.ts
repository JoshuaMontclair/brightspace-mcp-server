import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGetRoster } from "../../src/tools/get-roster.js";
import type { D2LApiClient } from "../../src/api/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolResult = { content: { type: string; text: string }[] };
type ToolHandler = (args: unknown) => Promise<ToolResult>;

// The tool only exists as a handler handed to the server, so capture it and
// call it the way an MCP client would.
function registerAndCapture(apiClient: D2LApiClient): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, fn: ToolHandler) => {
      handler = fn;
    },
  } as unknown as McpServer;

  registerGetRoster(server, apiClient);

  if (!handler) throw new Error("get_roster was never registered");
  return handler;
}

const COURSE_ID = 12345;
const PAGE_SIZE = 50;

function classlistUser(index: number) {
  return {
    Identifier: index,
    DisplayName: `Student ${index}`,
    Email: `student${index}@purdue.edu`,
    FirstName: "Student",
    LastName: String(index),
    RoleId: 110,
    ClasslistRoleDisplayName: "Student",
    IsOnline: false,
    LastAccessed: null,
  };
}

/**
 * A classlist of `total` people served PAGE_SIZE at a time, with the bookmark
 * carrying the offset. `failAfter` makes every request past that count throw,
 * standing in for the 429 a long walk eventually collects.
 */
function createClasslistClient(total: number, failAfter = Infinity) {
  const get = vi.fn(async (path: string) => {
    if (get.mock.calls.length > failAfter) {
      throw new Error("429 Too Many Requests");
    }

    const offset = Number(
      new URL(`https://tenant.example${path}`).searchParams.get("bookmark") ?? 0
    );
    const end = Math.min(offset + PAGE_SIZE, total);
    const objects = [];
    for (let i = offset; i < end; i += 1) objects.push(classlistUser(i));

    return { Objects: objects, Next: end < total ? String(end) : null };
  });

  const apiClient = {
    get,
    le: (orgUnitId: number, path: string) => `/d2l/api/le/1.91/${orgUnitId}${path}`,
  } as unknown as D2LApiClient;

  return { apiClient, get };
}

const rosterOf = (result: ToolResult) =>
  JSON.parse(result.content[0].text) as { name: string; email: string | null }[];

describe("get_roster", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.clearAllMocks();
  });

  it("caps the roster without walking the rest of a large classlist", async () => {
    const { apiClient, get } = createClasslistClient(900);
    const getRoster = registerAndCapture(apiClient);

    const roster = rosterOf(
      await getRoster({ courseId: COURSE_ID, includeStudents: true })
    );

    expect(roster).toHaveLength(100);
    expect(roster[0].name).toBe("Student 0");
    // 900 students is 18 pages; everything past the cap would be discarded, so
    // only the pages that reach it — plus the one that proves there are more —
    // are worth a round trip.
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("still answers when a page past the cap would have failed", async () => {
    const { apiClient } = createClasslistClient(900, 3);
    const getRoster = registerAndCapture(apiClient);

    const roster = rosterOf(
      await getRoster({ courseId: COURSE_ID, includeStudents: true })
    );

    expect(roster).toHaveLength(100);
  });

  it("returns the whole classlist when it fits under the cap", async () => {
    const { apiClient, get } = createClasslistClient(30);
    const getRoster = registerAndCapture(apiClient);

    const roster = rosterOf(
      await getRoster({ courseId: COURSE_ID, includeStudents: true })
    );

    expect(roster).toHaveLength(30);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("walks every page of a classlist that spans pages under the cap", async () => {
    const { apiClient, get } = createClasslistClient(80);
    const getRoster = registerAndCapture(apiClient);

    const roster = rosterOf(
      await getRoster({ courseId: COURSE_ID, includeStudents: true })
    );

    expect(roster).toHaveLength(80);
    expect(roster[79].email).toBe("student79@purdue.edu");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("reports a failure rather than a short roster when the first page fails", async () => {
    const { apiClient } = createClasslistClient(900, 0);
    const getRoster = registerAndCapture(apiClient);

    const result = await getRoster({ courseId: COURSE_ID, includeStudents: true });

    expect(result.content[0].text).toContain("unexpected error");
  });
});
