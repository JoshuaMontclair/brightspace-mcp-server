import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractOfficeText, OFFICE_MIME_TYPES } from "../../src/utils/office-extractor.js";

const pack = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
  );

const xlsx = (opts?: { inline?: boolean }) =>
  pack({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Costos" sheetId="1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<sst><si><t>Concepto</t></si><si><t>Valor</t></si><si><t>Interés</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1500000</v></c></row>
      <row r="3"></row>
      <row r="4"><c r="C4"${opts?.inline ? ' t="inlineStr"><is><t>en línea</t></is>' : "><v>42</v>"}</c></row>
    </sheetData></worksheet>`,
  });

describe("extractOfficeText", () => {
  it("renders a spreadsheet as tab-separated rows under its sheet name", () => {
    const text = extractOfficeText(xlsx(), "xlsx")!;
    expect(text).toContain("### Sheet: Costos");
    expect(text).toContain("Concepto\tValor");
    expect(text).toContain("Interés\t1500000");
  });

  it("resolves shared strings rather than emitting their indices", () => {
    const text = extractOfficeText(xlsx(), "xlsx")!;
    expect(text).not.toMatch(/^0\t1$/m);
  });

  it("keeps column position for cells that skip earlier columns", () => {
    // C4 is the third column, so it must be preceded by two empty fields
    const text = extractOfficeText(xlsx(), "xlsx")!;
    expect(text).toContain("\t\t42");
  });

  it("drops fully empty rows", () => {
    const text = extractOfficeText(xlsx(), "xlsx")!;
    expect(text.split("\n").some((l) => l.trim() === "")).toBe(false);
  });

  it("reads inline strings", () => {
    const text = extractOfficeText(xlsx({ inline: true }), "xlsx")!;
    expect(text).toContain("en línea");
  });

  it("extracts one line per Word paragraph and joins split runs", () => {
    const docx = pack({
      "word/document.xml": `<w:document><w:body>
        <w:p><w:r><w:t>Taller </w:t></w:r><w:r><w:t>1</w:t></w:r></w:p>
        <w:p><w:r><w:t>Entregar el lunes</w:t></w:r></w:p>
        <w:p></w:p>
      </w:body></w:document>`,
    });
    expect(extractOfficeText(docx, "docx")).toBe("Taller 1\nEntregar el lunes");
  });

  it("labels each slide of a deck", () => {
    const pptx = pack({
      "ppt/slides/slide1.xml": `<p:sld><a:t>Introducción</a:t></p:sld>`,
      "ppt/slides/slide2.xml": `<p:sld><a:t>Conclusiones</a:t></p:sld>`,
    });
    const text = extractOfficeText(pptx, "pptx")!;
    expect(text).toContain("### Slide 1\nIntroducción");
    expect(text).toContain("### Slide 2\nConclusiones");
  });

  it("decodes XML entities", () => {
    const docx = pack({
      "word/document.xml": `<w:document><w:p><w:r><w:t>Costo &amp; margen &lt;alto&gt;</w:t></w:r></w:p></w:document>`,
    });
    expect(extractOfficeText(docx, "docx")).toBe("Costo & margen <alto>");
  });

  it("returns null instead of throwing on a non-zip buffer", () => {
    expect(extractOfficeText(Buffer.from("not a zip at all"), "xlsx")).toBeNull();
  });

  it("returns null when the archive has no readable parts", () => {
    expect(extractOfficeText(pack({ "docProps/app.xml": "<Properties/>" }), "xlsx")).toBeNull();
  });

  it("maps the three OOXML mime types", () => {
    expect(Object.values(OFFICE_MIME_TYPES).sort()).toEqual(["docx", "pptx", "xlsx"]);
  });
});
