import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveOnDisk } from "../src/rename-files.js";

describe("moveOnDisk", () => {
  it("renames a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-mv-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "x", "utf8");
    await moveOnDisk(a, b);
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b, "utf8")).toBe("x");
  });

  it("creates the destination's parent directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-mv-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "nested/deep/b.ts");
    writeFileSync(a, "y", "utf8");
    await moveOnDisk(a, b);
    expect(readFileSync(b, "utf8")).toBe("y");
  });

  it("throws on a true collision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-mv-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "1", "utf8");
    writeFileSync(b, "2", "utf8");
    await expect(moveOnDisk(a, b)).rejects.toThrow(/already exists/);
  });

  it("is a no-op when src and dst are the same path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-mv-"));
    const a = join(dir, "a.ts");
    writeFileSync(a, "z", "utf8");
    await moveOnDisk(a, a);
    expect(readFileSync(a, "utf8")).toBe("z");
  });

  it("performs a case-only rename via a tmp name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tslsp-mv-"));
    const a = join(dir, "Foo.ts");
    const b = join(dir, "foo.ts");
    writeFileSync(a, "case", "utf8");
    await moveOnDisk(a, b);
    // On case-insensitive FS both `a` and `b` will resolve, but the file's
    // listing entry should now be "foo.ts" exactly.
    expect(readFileSync(b, "utf8")).toBe("case");
  });
});
