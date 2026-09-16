/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createHash } from "node:crypto";
import type { D2LApiClient } from "./client.js";
import { log } from "../utils/logger.js";

/**
 * Bookmark pagination for the two envelopes D2L answers list endpoints with:
 *
 *   { Items, PagingInfo: { HasMoreItems, Bookmark } }  — LP, e.g. enrollments
 *   { Objects, Next }                                  — LE, e.g. the paged classlist
 *
 * Tools that read only the first page quietly lose everything after it: a
 * student with more enrollments than one page gets a short course list, and
 * every tool that fans out over enrollments then skips those courses entirely.
 *
 * Every loop here is bounded three times over — by a page ceiling, by the set
 * of paths it has already requested, and, when the caller only wants the first
 * N items, by that count. A tenant that keeps answering "there is more" while
 * handing back a cursor pointing at a page we just read would otherwise spin
 * forever, and an MCP tool that never returns is worse than one that returns a
 * short answer and says so.
 *
 * A cursor the tenant ignores is a correctness problem as well as a liveness
 * one: the bookmark parameter and the Next shapes below follow D2L convention
 * rather than a contract, so a tenant that does not understand them answers
 * with the page we are already holding. Each page is therefore fingerprinted,
 * and a repeat is dropped before it is accumulated — stopping on it but keeping
 * it would report every row of that page twice, which reads as a real, longer
 * course list rather than as a failure.
 */

/** Pages, not items. Far past any real enrollment list or classlist. */
export const DEFAULT_MAX_PAGES = 200;

export interface PaginateOptions {
  /** Cache TTL in ms, passed through to the client for every page. */
  ttl?: number;
  /** Page ceiling for this call. Defaults to DEFAULT_MAX_PAGES. */
  maxPages?: number;
  /**
   * Stop once this many items are collected. Pages are kept whole, so the
   * result can overshoot the bound. A caller that caps its own output passes
   * its cap plus one: that still distinguishes a complete list from a truncated
   * one, without paying round trips for pages it would immediately discard.
   */
  maxItems?: number;
}

/** The { Items, PagingInfo } envelope. Every field is optional — tenants omit them. */
export interface PagedItemsResponse<T> {
  Items?: T[] | null;
  PagingInfo?: { HasMoreItems?: boolean; Bookmark?: string | null } | null;
}

/** The { Objects, Next } envelope. */
export interface PagedObjectsResponse<T> {
  Objects?: T[] | null;
  Next?: string | null;
}

/** What one page contributed, and where the page after it lives. */
interface PageReading<T> {
  items: T[];
  /** Request path of the next page, or null when this page was the last one. */
  nextPath: string | null;
}

/**
 * Fetch every item of a { Items, PagingInfo } endpoint, in server order.
 *
 * @param firstPath - Fully built path of the first page, query string included
 */
export async function fetchAllItems<T>(
  apiClient: D2LApiClient,
  firstPath: string,
  options?: PaginateOptions
): Promise<T[]> {
  return collectPages<T>(apiClient, firstPath, options, (page) => {
    const envelope = (page ?? {}) as PagedItemsResponse<T>;
    const paging = envelope.PagingInfo;
    const bookmark = paging?.Bookmark;

    return {
      items: envelope.Items ?? [],
      // "More items" without a bookmark leaves nowhere to go, so it ends the
      // walk rather than re-requesting the page we are already holding.
      nextPath:
        paging?.HasMoreItems && bookmark ? appendBookmark(firstPath, bookmark) : null,
    };
  });
}

/**
 * Fetch every object of a { Objects, Next } endpoint, in server order.
 *
 * @param firstPath - Fully built path of the first page, query string included
 */
export async function fetchAllObjects<T>(
  apiClient: D2LApiClient,
  firstPath: string,
  options?: PaginateOptions
): Promise<T[]> {
  return collectPages<T>(apiClient, firstPath, options, (page) => {
    const envelope = (page ?? {}) as PagedObjectsResponse<T>;
    const next = envelope.Next;

    return {
      items: envelope.Objects ?? [],
      nextPath: next ? resolveNext(firstPath, next) : null,
    };
  });
}

/**
 * Walk pages until the endpoint runs out of them, one of the bounds trips, a
 * page comes back that we already hold, or the client throws. Errors are not
 * swallowed: a failed page mid-walk is a real failure, and a half list reported
 * as a whole one is the bug being fixed.
 */
async function collectPages<T>(
  apiClient: D2LApiClient,
  firstPath: string,
  options: PaginateOptions | undefined,
  readPage: (page: unknown) => PageReading<T>
): Promise<T[]> {
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options?.maxItems;
  const requestOptions = options?.ttl ? { ttl: options.ttl } : undefined;

  const collected: T[] = [];
  // Every path requested so far, the first one included, so a cursor that
  // points back at a page we already read ends the walk instead of restarting it.
  const requested = new Set<string>([firstPath]);
  // ...and every page already collected, because a tenant that ignores the
  // cursor hands back a page we hold while offering a cursor we have not seen.
  const collectedPages = new Set<string>();
  let path: string | null = firstPath;
  let pages = 0;

  while (path !== null) {
    const page = await apiClient.get<unknown>(path, requestOptions);
    pages += 1;

    const { items, nextPath } = readPage(page);
    const pageId = fingerprint(items);

    // Checked before the push, not after: a duplicate that reaches `collected`
    // is indistinguishable from a course list twice as long as it really is.
    if (pageId !== null && collectedPages.has(pageId)) {
      log(
        "WARN",
        "Pagination stopped: Brightspace re-served a page already fetched — duplicate dropped",
        { firstPath, pages, items: collected.length }
      );
      break;
    }

    if (pageId !== null) collectedPages.add(pageId);
    collected.push(...items);

    if (nextPath === null) break;

    if (requested.has(nextPath)) {
      log(
        "WARN",
        "Pagination stopped: Brightspace pointed back at a page already fetched",
        { firstPath, pages, items: collected.length }
      );
      break;
    }

    // Not a warning: the caller asked for a bounded slice and has one.
    if (maxItems !== undefined && collected.length >= maxItems) {
      log("DEBUG", "Pagination stopped at the caller's item bound", {
        firstPath,
        pages,
        items: collected.length,
      });
      break;
    }

    if (pages >= maxPages) {
      log(
        "WARN",
        `Pagination stopped at the ${maxPages}-page ceiling — results are incomplete`,
        { firstPath, items: collected.length }
      );
      break;
    }

    requested.add(nextPath);
    path = nextPath;
  }

  return collected;
}

/**
 * A page's items hashed, or null for a page not worth comparing.
 *
 * Hashing keeps the walk's memory flat where keeping a copy of every page would
 * grow it with the list. An empty page is never compared: two of them in a row
 * are ordinary, and stopping on the second would truncate a walk that the page
 * ceiling and the requested-path set already bound.
 */
function fingerprint(items: unknown[]): string | null {
  if (items.length === 0) return null;

  try {
    return createHash("sha256").update(JSON.stringify(items)).digest("hex");
  } catch {
    // A page that will not serialize cannot be compared. Losing the duplicate
    // check is survivable; throwing here would lose the whole list.
    return null;
  }
}

/** The first page's path with a bookmark on it, opening the query string if needed. */
function appendBookmark(firstPath: string, bookmark: string): string {
  const separator = firstPath.includes("?") ? "&" : "?";
  return `${firstPath}${separator}bookmark=${encodeURIComponent(bookmark)}`;
}

/**
 * A Next value resolved to a request path. Tenants send it as an absolute URL,
 * as a site-relative path, or as a bare bookmark, and the client takes paths.
 */
function resolveNext(firstPath: string, next: string): string {
  if (/^https?:\/\//i.test(next)) {
    const url = new URL(next);
    return `${url.pathname}${url.search}`;
  }

  // Already a path; appending it as a bookmark would ask for a page that does not exist.
  if (next.startsWith("/")) return next;

  return appendBookmark(firstPath, next);
}
