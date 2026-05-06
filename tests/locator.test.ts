import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateIdentifierInRange } from "../src/locator.js";

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tslsp-loc-"));
  file = join(dir, "src.ts");
  writeFileSync(
    file,
    [
      "export function double(x: number): number {",
      "  return x * 2;",
      "}",
      "",
      "// trailing comment with double in it",
    ].join("\n"),
    "utf8",
  );
});

describe("locateIdentifierInRange", () => {
  it("finds the identifier inside a single-line range", async () => {
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 50 } },
      "double",
    );
    expect(pos).toEqual({ line: 0, character: 16 });
  });

  it("scans across a multi-line range and stops at the first hit", async () => {
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      "double",
    );
    expect(pos.line).toBe(0);
    expect(pos.character).toBe(16);
  });

  it("respects the column window on the start and end lines", async () => {
    // Search starting AFTER the identifier on line 0 → should not find it on line 0,
    // and the range ends before the trailing comment, so should fall back to range start.
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 25 }, end: { line: 0, character: 40 } },
      "double",
    );
    expect(pos).toEqual({ line: 0, character: 25 }); // fallback to range.start
  });

  it("uses word boundaries (no partial matches)", async () => {
    // 'doublewide' should not match 'double'.
    writeFileSync(file, "const doublewide = 1;\n// double\n", "utf8");
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 0 }, end: { line: 1, character: 20 } },
      "double",
    );
    expect(pos.line).toBe(1); // matched the comment, not 'doublewide'
  });
});
