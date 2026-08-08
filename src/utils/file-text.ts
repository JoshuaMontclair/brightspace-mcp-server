/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { fileTypeFromBuffer } from "file-type";
import { extractPdfText } from "./pdf-extractor.js";
import { extractOfficeText, OFFICE_MIME_TYPES } from "./office-extractor.js";
import { convertHtmlToMarkdown } from "./html-converter.js";
import { log } from "./logger.js";

/**
 * Cap on inlined text. Course files can be large, and a tool result that
 * blows the context window is worse than a truncated one the caller knows
 * is truncated.
 */
export const MAX_INLINE_TEXT = 100_000;

export interface ExtractedText {
  /** Extracted text, truncated to MAX_INLINE_TEXT. Null when unsupported. */
  text: string | null;
  /** How the text was obtained, or why it could not be. */
  method: "pdf" | "office" | "plain" | "html" | "unsupported" | "failed";
  mimeType: string;
  truncated: boolean;
  /** Set when text is null, explaining what the caller can still do. */
  note?: string;
}

/** Extensions that are plain text regardless of what magic-byte sniffing says. */
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|rtf|tex|bib|c|h|cpp|hpp|cs|java|py|js|ts|jsx|tsx|rb|go|rs|php|sql|sh|bash|zsh|r|m|swift|kt|scala|ipynb)$/i;

/**
 * Turn a downloaded course file into text an LLM can read.
 *
 * Never throws: every failure path returns a result explaining what happened,
 * because the caller has already spent a request fetching the bytes and can
 * still offer the file itself.
 */
export async function extractFileText(
  buffer: Buffer,
  filename: string
): Promise<ExtractedText> {
  const detected = await fileTypeFromBuffer(buffer);
  const mimeType = detected?.mime ?? "application/octet-stream";

  const finish = (
    text: string | null,
    method: ExtractedText["method"],
    note?: string
  ): ExtractedText => {
    if (text === null) return { text: null, method, mimeType, truncated: false, note };
    const truncated = text.length > MAX_INLINE_TEXT;
    return {
      text: truncated ? text.slice(0, MAX_INLINE_TEXT) : text,
      method,
      mimeType,
      truncated,
    };
  };

  try {
    if (mimeType === "application/pdf") {
      const pdf = await extractPdfText(buffer);
      if (!pdf || !pdf.text.trim()) {
        return finish(
          null,
          "failed",
          "This PDF has no extractable text layer — it is probably a scan. Download it and open it directly."
        );
      }
      return finish(pdf.text, "pdf");
    }

    const officeKind = OFFICE_MIME_TYPES[mimeType];
    if (officeKind) {
      const text = extractOfficeText(buffer, officeKind);
      if (!text) {
        return finish(
          null,
          "failed",
          `Could not read text out of this ${officeKind} file. Download it and open it directly.`
        );
      }
      return finish(text, "office");
    }

    if (mimeType === "text/html" || /\.html?$/i.test(filename)) {
      const html = buffer.toString("utf-8");
      return finish(convertHtmlToMarkdown(html).markdown, "html");
    }

    // file-type cannot detect plain text, so fall back to the extension plus a
    // binary sniff on the leading bytes.
    const looksBinary = buffer.subarray(0, 4096).includes(0);
    if (!looksBinary && (TEXT_EXTENSIONS.test(filename) || !detected)) {
      return finish(buffer.toString("utf-8"), "plain");
    }

    return finish(
      null,
      "unsupported",
      `No text extractor for ${mimeType}. Download the file to inspect it.`
    );
  } catch (error) {
    log("WARN", `Text extraction failed for ${filename}`, error);
    return finish(null, "failed", "Text extraction failed. Download the file instead.");
  }
}
