/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { GetAssignmentAttachmentSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { extractFileText } from "../utils/file-text.js";
import { secureDownload } from "../utils/download-helpers.js";
import { MAX_FILE_SIZE, validateContentId } from "../utils/file-validator.js";
import { log } from "../utils/logger.js";
import path from "node:path";
import fs from "node:fs/promises";

/** Filename from Content-Disposition, preferring the RFC 5987 form. */
function filenameFromDisposition(disposition: string): string | null {
  const extended = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      // Fall through to the plain form
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  if (plain?.[1]) {
    try {
      return decodeURIComponent(plain[1].trim());
    } catch {
      return plain[1].trim();
    }
  }
  return null;
}

/**
 * Register get_assignment_attachment tool
 */
export function registerGetAssignmentAttachment(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_assignment_attachment",
    {
      title: "Read Assignment Attachment",
      description:
        "Read the contents of a file the instructor attached to an assignment (handout, worksheet, template, rubric document). " +
        "Returns the extracted text so you can analyse it directly — spreadsheets come back as tab-separated rows per sheet, documents and slide decks as text, PDFs as their text layer. " +
        "Get courseId, folderId (the assignment id) and fileId from the `attachments` array returned by get_assignments. " +
        "Optionally pass downloadPath to also save the original file; if you do, you MUST ask the user where to save it first. " +
        "For files the student submitted, use download_file instead.",
      inputSchema: GetAssignmentAttachmentSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_assignment_attachment tool called", { args });

        const { courseId, folderId, fileId, downloadPath } =
          GetAssignmentAttachmentSchema.parse(args);

        validateContentId(courseId);
        validateContentId(folderId);
        validateContentId(fileId);

        if (downloadPath !== undefined) {
          if (!path.isAbsolute(downloadPath)) {
            return errorResponse(
              "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
            );
          }
          try {
            const stats = await fs.stat(downloadPath);
            if (!stats.isDirectory()) {
              return errorResponse(`Download path is not a directory: ${downloadPath}`);
            }
          } catch (error: any) {
            if (error?.code === "ENOENT") {
              return errorResponse(`Download directory does not exist: ${downloadPath}`);
            }
            throw error;
          }
        }

        // Note: no trailing slash — D2L returns 404 for the slashed form here.
        const apiPath = apiClient.le(
          courseId,
          `/dropbox/folders/${folderId}/attachments/${fileId}`
        );
        const response = await apiClient.getRaw(apiPath);

        // Check the advertised size before reading the body into memory
        const contentLength = parseInt(
          response.headers.get("Content-Length") ?? "0",
          10
        );
        if (contentLength > MAX_FILE_SIZE) {
          return errorResponse(
            `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE) {
          return errorResponse(
            `Attachment too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
          );
        }

        const filename =
          filenameFromDisposition(response.headers.get("Content-Disposition") ?? "") ??
          `attachment-${fileId}`;

        const extracted = await extractFileText(buffer, filename);

        let savedPath: string | undefined;
        if (downloadPath) {
          const result = await secureDownload({
            targetDir: downloadPath,
            filename,
            data: buffer,
          });
          savedPath = result.path;
        }

        log(
          "INFO",
          `get_assignment_attachment: ${filename} (${buffer.length} bytes, ${extracted.mimeType}, extraction=${extracted.method})`
        );

        return toolResponse({
          fileName: filename,
          mimeType: extracted.mimeType,
          size: buffer.length,
          extraction: extracted.method,
          truncated: extracted.truncated || undefined,
          note: extracted.note,
          filePath: savedPath,
          content: extracted.text,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
