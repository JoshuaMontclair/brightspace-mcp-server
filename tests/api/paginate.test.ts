import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllItems,
  fetchAllObjects,
  DEFAULT_MAX_PAGES,
} from "../../src/api/paginate.js";
import type { D2LApiClient } from "../../src/api/client.js";

// A client that answers with scripted pages and records every path it was asked for.
function createScriptedClient(pages: Record<string, unknown>) {
  const requested: string[] = [];
  const get = vi.fn(async (path: string) => {
    requested.push(path);
    if (!(path in pages)) {
      throw new Error(`Unexpected request for ${path}`);
    }
    return pages[path];
  });
  return { apiClient: { get } as unknown as D2LApiClient, requested, get };
}

// A client that always claims one more page, with a fresh cursor every time.
function createEndlessClient(envelope: "items" | "objects") {
  const requested: string[] = [];
  const get = vi.fn(async (path: string) => {
    requested.push(path);
    const n = requested.length;
    return envelope === "items"
      ? { Items: [n], PagingInfo: { HasMoreItems: true, Bookmark: `b${n}` } }
      : { Objects: [n], Next: `b${n}` };
  });
  return { apiClient: { get } as unknown as D2LApiClient, requested, get };
}

// A client that ignores the cursor and keeps re-serving page one, handing back
// a fresh bookmark each time — what a tenant that does not know the `bookmark`
// parameter looks like from here. Nothing but the page contents gives it away.
function createStuckClient(envelope: "items" | "objects") {
  const requested: string[] = [];
  const get = vi.fn(async (path: string) => {
    requested.push(path);
    const n = requested.length;
    return envelope === "items"
      ? { Items: ["a", "b"], PagingInfo: { HasMoreItems: true, Bookmark: `cursor-${n}` } }
      : { Objects: ["a", "b"], Next: `cursor-${n}` };
  });
  return { apiClient: { get } as unknown as D2LApiClient, requested, get };
}

const ENROLLMENTS = "/d2l/api/lp/1.56/enrollments/myenrollments/?orgUnitTypeId=3";
const CLASSLIST = "/d2l/api/le/1.91/12345/classlist/paged/";

describe("pagination", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The bounds warn on stderr; keep the test output readable and assertable.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.clearAllMocks();
  });

  const warnings = () =>
    consoleError.mock.calls.map((call) => String(call[0])).join("\n");

  describe("fetchAllItems — { Items, PagingInfo }", () => {
    it("accumulates items across every page", async () => {
      const { apiClient, requested } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a", "b"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: {
          Items: ["c"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p3" },
        },
        [`${ENROLLMENTS}&bookmark=p3`]: {
          Items: ["d"],
          PagingInfo: { HasMoreItems: false },
        },
      });

      const items = await fetchAllItems<string>(apiClient, ENROLLMENTS);

      expect(items).toEqual(["a", "b", "c", "d"]);
      expect(requested).toEqual([
        ENROLLMENTS,
        `${ENROLLMENTS}&bookmark=p2`,
        `${ENROLLMENTS}&bookmark=p3`,
      ]);
    });

    it("opens a query string when the first path has none", async () => {
      const { apiClient, requested } = createScriptedClient({
        "/d2l/api/lp/1.56/enrollments/": {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        "/d2l/api/lp/1.56/enrollments/?bookmark=p2": { Items: ["b"] },
      });

      const items = await fetchAllItems<string>(
        apiClient,
        "/d2l/api/lp/1.56/enrollments/"
      );

      expect(items).toEqual(["a", "b"]);
      expect(requested[1]).toBe("/d2l/api/lp/1.56/enrollments/?bookmark=p2");
    });

    it("escapes bookmarks that are not URL-safe", async () => {
      const { apiClient, requested } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "a b&c" },
        },
        [`${ENROLLMENTS}&bookmark=a%20b%26c`]: { Items: ["b"] },
      });

      const items = await fetchAllItems<string>(apiClient, ENROLLMENTS);

      expect(items).toEqual(["a", "b"]);
      expect(requested[1]).toBe(`${ENROLLMENTS}&bookmark=a%20b%26c`);
    });

    it("makes one request when there is no next page", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: { Items: ["a", "b"], PagingInfo: { HasMoreItems: false } },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("makes one request when the envelope has no PagingInfo at all", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: { Items: ["a"] },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual(["a"]);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("stops when the server promises more but hands back no bookmark", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: { Items: ["a"], PagingInfo: { HasMoreItems: true } },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual(["a"]);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("tolerates a page with no Items", async () => {
      const { apiClient } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: null,
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: { Items: ["a"] },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual(["a"]);
    });

    it("stops when the server repeats a bookmark instead of looping forever", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "stuck" },
        },
        [`${ENROLLMENTS}&bookmark=stuck`]: {
          Items: ["b"],
          PagingInfo: { HasMoreItems: true, Bookmark: "stuck" },
        },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(2);
      expect(warnings()).toContain("Pagination stopped");
    });

    it("stops when a bookmark points back at a page already fetched", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: {
          Items: ["b"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("drops the duplicate when the server re-serves a page it already sent", async () => {
      const { apiClient, get } = createStuckClient("items");

      // Two real enrollments, not four: the second page is the first one again.
      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(2);
      expect(warnings()).toContain("re-served a page already fetched");
    });

    it("drops a page that repeats an earlier one, not only the page before it", async () => {
      const { apiClient } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: {
          Items: ["b"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p3" },
        },
        [`${ENROLLMENTS}&bookmark=p3`]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p4" },
        },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual([
        "a",
        "b",
      ]);
    });

    it("keeps a genuinely new page whose bookmark is echoed back", async () => {
      const { apiClient } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "same" },
        },
        // Same cursor, different rows: the page is real and must not be dropped.
        [`${ENROLLMENTS}&bookmark=same`]: {
          Items: ["b"],
          PagingInfo: { HasMoreItems: true, Bookmark: "same" },
        },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual([
        "a",
        "b",
      ]);
    });

    it("walks past two empty pages in a row", async () => {
      const { apiClient } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: [],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: {
          Items: [],
          PagingInfo: { HasMoreItems: true, Bookmark: "p3" },
        },
        [`${ENROLLMENTS}&bookmark=p3`]: { Items: ["a"] },
      });

      expect(await fetchAllItems<string>(apiClient, ENROLLMENTS)).toEqual(["a"]);
    });

    it("stops at the item bound, keeping the page that crossed it whole", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a", "b"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: {
          Items: ["c", "d"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p3" },
        },
      });

      const items = await fetchAllItems<string>(apiClient, ENROLLMENTS, {
        maxItems: 3,
      });

      expect(items).toEqual(["a", "b", "c", "d"]);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("makes no second request when the first page already meets the item bound", async () => {
      const { apiClient, get } = createEndlessClient("items");

      expect(
        await fetchAllItems<number>(apiClient, ENROLLMENTS, { maxItems: 1 })
      ).toEqual([1]);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("walks to the end when the list never reaches the item bound", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: { Items: ["b"] },
      });

      const items = await fetchAllItems<string>(apiClient, ENROLLMENTS, {
        maxItems: 100,
      });

      expect(items).toEqual(["a", "b"]);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("honours an explicit page ceiling", async () => {
      const { apiClient, get } = createEndlessClient("items");

      const items = await fetchAllItems<number>(apiClient, ENROLLMENTS, {
        maxPages: 4,
      });

      expect(items).toEqual([1, 2, 3, 4]);
      expect(get).toHaveBeenCalledTimes(4);
      expect(warnings()).toContain("4-page ceiling");
    });

    it("falls back to the default page ceiling", async () => {
      const { apiClient, get } = createEndlessClient("items");

      const items = await fetchAllItems<number>(apiClient, ENROLLMENTS);

      expect(items).toHaveLength(DEFAULT_MAX_PAGES);
      expect(get).toHaveBeenCalledTimes(DEFAULT_MAX_PAGES);
      expect(warnings()).toContain(`${DEFAULT_MAX_PAGES}-page ceiling`);
    });

    it("does not warn when the last page lands exactly on the ceiling", async () => {
      const { apiClient } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: { Items: ["b"] },
      });

      const items = await fetchAllItems<string>(apiClient, ENROLLMENTS, {
        maxPages: 2,
      });

      expect(items).toEqual(["a", "b"]);
      expect(warnings()).not.toContain("Pagination stopped");
    });

    it("passes the cache TTL through on every page", async () => {
      const { apiClient, get } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "p2" },
        },
        [`${ENROLLMENTS}&bookmark=p2`]: { Items: ["b"] },
      });

      await fetchAllItems<string>(apiClient, ENROLLMENTS, { ttl: 60_000 });

      expect(get).toHaveBeenNthCalledWith(1, ENROLLMENTS, { ttl: 60_000 });
      expect(get).toHaveBeenNthCalledWith(2, `${ENROLLMENTS}&bookmark=p2`, {
        ttl: 60_000,
      });
    });

    it("lets a failed page surface rather than returning a half list", async () => {
      const { apiClient } = createScriptedClient({
        [ENROLLMENTS]: {
          Items: ["a"],
          PagingInfo: { HasMoreItems: true, Bookmark: "gone" },
        },
      });

      await expect(fetchAllItems<string>(apiClient, ENROLLMENTS)).rejects.toThrow(
        "Unexpected request"
      );
    });
  });

  describe("fetchAllObjects — { Objects, Next }", () => {
    it("accumulates objects across every page", async () => {
      const { apiClient, requested } = createScriptedClient({
        [CLASSLIST]: {
          Objects: ["a", "b"],
          // D2L usually answers with an absolute next-page URL
          Next: `https://purdue.brightspace.com${CLASSLIST}?bookmark=p2`,
        },
        [`${CLASSLIST}?bookmark=p2`]: {
          Objects: ["c"],
          // ...but a bare bookmark is also seen in the wild
          Next: "p3",
        },
        [`${CLASSLIST}?bookmark=p3`]: { Objects: ["d"], Next: null },
      });

      const objects = await fetchAllObjects<string>(apiClient, CLASSLIST);

      expect(objects).toEqual(["a", "b", "c", "d"]);
      expect(requested).toEqual([
        CLASSLIST,
        `${CLASSLIST}?bookmark=p2`,
        `${CLASSLIST}?bookmark=p3`,
      ]);
    });

    it("follows a site-relative Next as a path, not a bookmark", async () => {
      const { apiClient, requested } = createScriptedClient({
        [CLASSLIST]: { Objects: ["a"], Next: `${CLASSLIST}?bookmark=p2` },
        [`${CLASSLIST}?bookmark=p2`]: { Objects: ["b"] },
      });

      expect(await fetchAllObjects<string>(apiClient, CLASSLIST)).toEqual([
        "a",
        "b",
      ]);
      expect(requested[1]).toBe(`${CLASSLIST}?bookmark=p2`);
    });

    it("keeps the query string of a filtered first page when appending a bookmark", async () => {
      const filtered = `${CLASSLIST}?roleId=109&searchTerm=smith`;
      const { apiClient, requested } = createScriptedClient({
        [filtered]: { Objects: ["a"], Next: "p2" },
        [`${filtered}&bookmark=p2`]: { Objects: ["b"] },
      });

      expect(await fetchAllObjects<string>(apiClient, filtered)).toEqual([
        "a",
        "b",
      ]);
      expect(requested[1]).toBe(`${filtered}&bookmark=p2`);
    });

    it("makes one request when there is no Next", async () => {
      const { apiClient, get } = createScriptedClient({
        [CLASSLIST]: { Objects: ["a", "b"], Next: null },
      });

      expect(await fetchAllObjects<string>(apiClient, CLASSLIST)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("tolerates a page with no Objects", async () => {
      const { apiClient } = createScriptedClient({
        [CLASSLIST]: { Next: "p2" },
        [`${CLASSLIST}?bookmark=p2`]: { Objects: ["a"] },
      });

      expect(await fetchAllObjects<string>(apiClient, CLASSLIST)).toEqual(["a"]);
    });

    it("stops when the server repeats a next link instead of looping forever", async () => {
      const stuck = `https://purdue.brightspace.com${CLASSLIST}?bookmark=stuck`;
      const { apiClient, get } = createScriptedClient({
        [CLASSLIST]: { Objects: ["a"], Next: stuck },
        [`${CLASSLIST}?bookmark=stuck`]: { Objects: ["b"], Next: stuck },
      });

      expect(await fetchAllObjects<string>(apiClient, CLASSLIST)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(2);
      expect(warnings()).toContain("Pagination stopped");
    });

    it("stops when a next link points back at the first page", async () => {
      const { apiClient, get } = createScriptedClient({
        [CLASSLIST]: {
          Objects: ["a"],
          Next: `https://purdue.brightspace.com${CLASSLIST}`,
        },
      });

      expect(await fetchAllObjects<string>(apiClient, CLASSLIST)).toEqual(["a"]);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("drops the duplicate when the server re-serves a page it already sent", async () => {
      const { apiClient, get } = createStuckClient("objects");

      // A two-person classlist stays two people, not two of each.
      expect(await fetchAllObjects<string>(apiClient, CLASSLIST)).toEqual([
        "a",
        "b",
      ]);
      expect(get).toHaveBeenCalledTimes(2);
      expect(warnings()).toContain("re-served a page already fetched");
    });

    it("stops at the item bound, keeping the page that crossed it whole", async () => {
      const { apiClient, get } = createScriptedClient({
        [CLASSLIST]: { Objects: ["a", "b"], Next: "p2" },
        [`${CLASSLIST}?bookmark=p2`]: { Objects: ["c", "d"], Next: "p3" },
      });

      const objects = await fetchAllObjects<string>(apiClient, CLASSLIST, {
        maxItems: 3,
      });

      expect(objects).toEqual(["a", "b", "c", "d"]);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("honours an explicit page ceiling", async () => {
      const { apiClient, get } = createEndlessClient("objects");

      const objects = await fetchAllObjects<number>(apiClient, CLASSLIST, {
        maxPages: 3,
      });

      expect(objects).toEqual([1, 2, 3]);
      expect(get).toHaveBeenCalledTimes(3);
      expect(warnings()).toContain("3-page ceiling");
    });

    it("falls back to the default page ceiling", async () => {
      const { apiClient, get } = createEndlessClient("objects");

      const objects = await fetchAllObjects<number>(apiClient, CLASSLIST);

      expect(objects).toHaveLength(DEFAULT_MAX_PAGES);
      expect(get).toHaveBeenCalledTimes(DEFAULT_MAX_PAGES);
    });

    it("passes the cache TTL through on every page", async () => {
      const { apiClient, get } = createScriptedClient({
        [CLASSLIST]: { Objects: ["a"], Next: "p2" },
        [`${CLASSLIST}?bookmark=p2`]: { Objects: ["b"] },
      });

      await fetchAllObjects<string>(apiClient, CLASSLIST, { ttl: 3_600_000 });

      expect(get).toHaveBeenNthCalledWith(1, CLASSLIST, { ttl: 3_600_000 });
      expect(get).toHaveBeenNthCalledWith(2, `${CLASSLIST}?bookmark=p2`, {
        ttl: 3_600_000,
      });
    });
  });
});
