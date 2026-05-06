import { describe, expect, it } from "vitest";
import {
  formatDiagnostic,
  formatHover,
  formatLocations,
  formatOutline,
  kindName,
  uriToRel,
} from "../src/format.js";
import type { Diagnostic, DocumentSymbol, Hover, Location } from "../src/lsp-client.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("uriToRel", () => {
  it("strips the workspace root prefix", () => {
    const root = "/workspace/proj";
    expect(uriToRel(`file://${root}/src/foo.ts`, root)).toBe("src/foo.ts");
  });

  it("returns a relative path with .. when the target is outside the root", () => {
    expect(uriToRel("file:///elsewhere/x.ts", "/workspace/proj")).toBe("../../elsewhere/x.ts");
  });
});

describe("kindName", () => {
  it("maps known LSP symbol kinds", () => {
    expect(kindName(12)).toBe("function");
    expect(kindName(5)).toBe("class");
    expect(kindName(11)).toBe("interface");
  });

  it("falls back to a generic label for unknown kinds", () => {
    expect(kindName(999)).toBe("kind999");
  });
});

describe("formatHover", () => {
  it("returns a friendly message when null", () => {
    expect(formatHover(null)).toMatch(/no hover information/i);
  });

  it("handles plain string contents", () => {
    expect(formatHover({ contents: "hello" } as Hover)).toBe("hello");
  });

  it("handles MarkupContent contents", () => {
    const h = { contents: { kind: "markdown" as const, value: "**bold**" } };
    expect(formatHover(h)).toBe("**bold**");
  });

  it("normalizes typescript fences to ts and trims", () => {
    const h = { contents: "```typescript\nfoo\n```\n\n\n\n" };
    expect(formatHover(h as Hover)).toBe("```ts\nfoo\n```");
  });

  it("joins array contents", () => {
    const h = { contents: ["a", { value: "b" }] as unknown[] };
    expect(formatHover(h as Hover)).toBe("a\n\nb");
  });
});

describe("formatLocations", () => {
  it("renders path:line:col with the relevant source line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-fmt-"));
    const file = join(dir, "x.ts");
    writeFileSync(file, "function add(a, b) {\n  return a + b;\n}\n", "utf8");
    const loc: Location = {
      uri: pathToFileURL(file).toString(),
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
    };
    const out = await formatLocations([loc], dir);
    expect(out.text).toContain("x.ts:1:10");
    expect(out.text).toContain("function add(a, b)");
    expect(out.total).toBe(1);
    expect(out.returned).toBe(1);
  });

  it("truncates when over the cap and notes the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-fmt-"));
    const file = join(dir, "y.ts");
    writeFileSync(file, "x;\n", "utf8");
    const loc: Location = {
      uri: pathToFileURL(file).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    const locs = Array.from({ length: 5 }, () => loc);
    const out = await formatLocations(locs, dir, 2);
    expect(out.returned).toBe(2);
    expect(out.total).toBe(5);
    expect(out.text).toMatch(/showing 2 of 5/);
  });
});

describe("formatOutline", () => {
  it("indents nested children", () => {
    const symbols: DocumentSymbol[] = [
      {
        name: "Outer",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        children: [
          {
            name: "method",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 3, character: 0 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          },
        ],
      },
    ];
    const out = formatOutline(symbols);
    expect(out).toContain("class Outer");
    expect(out).toMatch(/^  method method/m);
    expect(out).toMatch(/\(line 1\)/);
  });

  it("returns (empty) for no symbols", () => {
    expect(formatOutline([])).toBe("(empty)");
  });
});

describe("formatDiagnostic", () => {
  it("formats severity, position, and message", () => {
    const d: Diagnostic = {
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } },
      severity: 1,
      message: "Cannot find name 'foo'.",
      code: 2304,
    };
    expect(formatDiagnostic(d, "src/x.ts")).toBe(
      "src/x.ts:10:5 [error] (2304) Cannot find name 'foo'.",
    );
  });

  it("flattens multi-line messages to a single line", () => {
    const d: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: 2,
      message: "line one\nline two",
    };
    expect(formatDiagnostic(d, "x.ts")).toBe("x.ts:1:1 [warn] line one line two");
  });
});
