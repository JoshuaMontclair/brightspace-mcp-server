/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { unzipSync, strFromU8 } from "fflate";
import { log } from "./logger.js";

/**
 * Text extraction for the OOXML formats coursework actually ships in:
 * .xlsx, .docx and .pptx. All three are ZIP archives of XML parts, so one
 * unzip plus format-specific scraping covers them.
 *
 * The goal is text an LLM can reason about, not fidelity: spreadsheets keep
 * their row/column grid (tab-separated) because a flat bag of cell values is
 * useless for answering questions about a sheet.
 */

/** Strip XML tags and decode the five predefined entities. */
function xmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** "BC12" -> 54 (0-based column index). */
function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/)?.[0] ?? "A";
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

type Zip = Record<string, Uint8Array>;

function readPart(zip: Zip, name: string): string | null {
  const entry = zip[name];
  return entry ? strFromU8(entry) : null;
}

/**
 * Spreadsheet -> one tab-separated block per sheet.
 * Cell values live in sharedStrings.xml when t="s"; inline otherwise.
 */
function extractXlsx(zip: Zip): string {
  const shared: string[] = [];
  const sharedXml = readPart(zip, "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      // A single string may be split across several <t> runs
      const runs = si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? [];
      shared.push(runs.map(xmlText).join(""));
    }
  }

  // Sheet display names, in workbook order
  const names: string[] = [];
  const workbook = readPart(zip, "xl/workbook.xml");
  if (workbook) {
    for (const m of workbook.matchAll(/<sheet[^>]*name="([^"]*)"/g)) {
      names.push(xmlText(m[1]));
    }
  }

  const sheetPaths = Object.keys(zip)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (p: string) => Number(p.match(/sheet(\d+)\.xml$/)?.[1] ?? 0);
      return n(a) - n(b);
    });

  const blocks: string[] = [];
  sheetPaths.forEach((path, i) => {
    const xml = readPart(zip, path);
    if (!xml) return;

    const lines: string[] = [];
    for (const rowXml of xml.match(/<row[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cellMatch of rowXml.matchAll(
        /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g
      )) {
        const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
        const body = cellMatch[2] ?? "";
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/t="([^"]*)"/)?.[1];

        let value = "";
        if (type === "s") {
          const idx = Number(xmlText(body.match(/<v>[\s\S]*?<\/v>/)?.[0] ?? ""));
          value = shared[idx] ?? "";
        } else if (type === "inlineStr") {
          value = (body.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map(xmlText).join("");
        } else {
          value = xmlText(body.match(/<v>[\s\S]*?<\/v>/)?.[0] ?? "");
        }

        if (ref) {
          const col = columnIndex(ref);
          while (cells.length < col) cells.push("");
          cells[col] = value;
        } else if (value) {
          cells.push(value);
        }
      }
      // Skip fully empty rows so blank grid regions don't dominate the output
      if (cells.some((c) => c !== "")) lines.push(cells.join("\t"));
    }

    if (lines.length > 0) {
      blocks.push(`### Sheet: ${names[i] ?? `sheet${i + 1}`}\n${lines.join("\n")}`);
    }
  });

  return blocks.join("\n\n");
}

/** Word document -> one line per paragraph. */
function extractDocx(zip: Zip): string {
  const xml = readPart(zip, "word/document.xml");
  if (!xml) return "";

  const paragraphs: string[] = [];
  for (const p of xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    const runs = p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [];
    const text = runs.map(xmlText).join("").trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs.join("\n");
}

/** Slide deck -> one block per slide. */
function extractPptx(zip: Zip): string {
  const slides = Object.keys(zip)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (p: string) => Number(p.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return n(a) - n(b);
    });

  const blocks: string[] = [];
  slides.forEach((path, i) => {
    const xml = readPart(zip, path);
    if (!xml) return;
    const runs = xml.match(/<a:t>[\s\S]*?<\/a:t>/g) ?? [];
    const text = runs.map(xmlText).filter(Boolean).join("\n").trim();
    if (text) blocks.push(`### Slide ${i + 1}\n${text}`);
  });
  return blocks.join("\n\n");
}

export type OfficeKind = "xlsx" | "docx" | "pptx";

/** MIME types this module can turn into text. */
export const OFFICE_MIME_TYPES: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/**
 * Extract readable text from an OOXML buffer.
 * Returns null on failure — callers still have the file itself.
 */
export function extractOfficeText(buffer: Buffer, kind: OfficeKind): string | null {
  try {
    const zip = unzipSync(new Uint8Array(buffer)) as Zip;
    const text =
      kind === "xlsx"
        ? extractXlsx(zip)
        : kind === "docx"
          ? extractDocx(zip)
          : extractPptx(zip);
    return text.trim().length > 0 ? text : null;
  } catch (error) {
    log("WARN", `Failed to extract text from ${kind}`, error);
    return null;
  }
}
