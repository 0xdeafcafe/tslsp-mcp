import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  arrayInner,
  coerce,
  enumValues,
  isArray,
  isBoolean,
  parseArgs,
  typeHint,
  unwrap,
} from "../src/cli-args.js";
import type { ToolDef } from "../src/tools.js";

describe("unwrap", () => {
  it("peels ZodOptional", () => {
    const s = z.string().optional();
    expect(unwrap(s)).toBeInstanceOf(z.ZodString);
  });

  it("peels ZodOptional + ZodNullable", () => {
    const s = z.number().nullable().optional();
    expect(unwrap(s)).toBeInstanceOf(z.ZodNumber);
  });

  it("does NOT walk into ZodArray (zod 4's .unwrap() returns the element)", () => {
    const s = z.array(z.string()).optional();
    const u = unwrap(s);
    expect(u).toBeInstanceOf(z.ZodArray);
    // would be ZodString if we mistakenly kept unwrapping
    expect(u).not.toBeInstanceOf(z.ZodString);
  });
});

describe("type predicates", () => {
  it("isBoolean works through ZodOptional", () => {
    expect(isBoolean(z.boolean().optional())).toBe(true);
    expect(isBoolean(z.string().optional())).toBe(false);
  });

  it("isArray works through ZodOptional (the regression case)", () => {
    expect(isArray(z.array(z.string()).optional())).toBe(true);
    expect(isArray(z.string().optional())).toBe(false);
  });
});

describe("arrayInner", () => {
  it("returns the element schema for ZodArray", () => {
    expect(arrayInner(z.array(z.string()))).toBeInstanceOf(z.ZodString);
  });
  it("returns the element schema for ZodOptional<ZodArray>", () => {
    expect(arrayInner(z.array(z.number()).optional())).toBeInstanceOf(z.ZodNumber);
  });
});

describe("enumValues", () => {
  it("extracts the value list", () => {
    const s = z.enum(["a", "b", "c"]);
    expect(enumValues(s).sort()).toEqual(["a", "b", "c"]);
  });
  it("works through ZodOptional", () => {
    const s = z.enum(["x", "y"]).optional();
    expect(enumValues(s).sort()).toEqual(["x", "y"]);
  });
});

describe("coerce", () => {
  it("parses numbers", () => {
    expect(coerce(z.number(), "42")).toBe(42);
    expect(coerce(z.number().optional(), "0")).toBe(0);
  });
  it("throws on non-numeric", () => {
    expect(() => coerce(z.number(), "abc")).toThrow(/expected number/);
  });
  it("parses booleans", () => {
    expect(coerce(z.boolean(), "true")).toBe(true);
    expect(coerce(z.boolean(), "1")).toBe(true);
    expect(coerce(z.boolean(), "false")).toBe(false);
  });
  it("validates enums", () => {
    const s = z.enum(["a", "b"]);
    expect(coerce(s, "a")).toBe("a");
    expect(() => coerce(s, "z")).toThrow(/expected one of/);
  });
  it("passes strings through", () => {
    expect(coerce(z.string(), "hello")).toBe("hello");
  });
});

describe("typeHint", () => {
  it("renders enum values", () => {
    expect(typeHint(z.enum(["a", "b", "c"]))).toBe("a|b|c");
  });
  it("renders number", () => {
    expect(typeHint(z.number())).toBe("number");
  });
  it("renders arrays as value[,…]", () => {
    expect(typeHint(z.array(z.string()).optional())).toMatch(/\[,…\]/);
  });
});

// minimal tool fixtures for parseArgs
const stringTool: ToolDef = {
  name: "stringy",
  description: "",
  positional: ["q"],
  inputSchema: {
    q: z.string().describe("query"),
    file: z.string().optional().describe("file"),
    limit: z.number().int().optional().describe("limit"),
    flag: z.boolean().optional().describe("flag"),
  },
  handler: async () => ({ text: "" }),
};

const arrayTool: ToolDef = {
  name: "arrayy",
  description: "",
  positional: ["files"],
  inputSchema: {
    files: z.array(z.string()).describe("files"),
    symbols: z.array(z.string()).optional().describe("symbols"),
  },
  handler: async () => ({ text: "" }),
};

describe("parseArgs", () => {
  it("parses positional + flags + booleans", () => {
    const out = parseArgs(stringTool, ["foo", "--file", "src/x.ts", "--limit", "10", "--flag"]);
    expect(out).toEqual({ q: "foo", file: "src/x.ts", limit: 10, flag: true });
  });

  it("supports --flag=value inline form", () => {
    const out = parseArgs(stringTool, ["foo", "--file=src/x.ts", "--limit=5"]);
    expect(out).toEqual({ q: "foo", file: "src/x.ts", limit: 5 });
  });

  it("supports --flag=false for booleans", () => {
    const out = parseArgs(stringTool, ["foo", "--flag=false"]);
    expect(out.flag).toBe(false);
  });

  it("accepts kebab-case flags and maps them to snake_case fields", () => {
    const tool: ToolDef = {
      name: "t",
      description: "",
      inputSchema: { new_name: z.string().describe("") },
      handler: async () => ({ text: "" }),
    };
    expect(parseArgs(tool, ["--new-name", "X"])).toEqual({ new_name: "X" });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(stringTool, ["foo", "--bogus", "x"])).toThrow(/unknown flag/);
  });

  it("rejects flags missing a value", () => {
    expect(() => parseArgs(stringTool, ["foo", "--file"])).toThrow(/requires a value/);
  });

  it("rejects extra positional args", () => {
    expect(() => parseArgs(stringTool, ["foo", "bar"])).toThrow(/unexpected/);
  });

  it("splits comma-separated array flags", () => {
    const out = parseArgs(arrayTool, ["a.ts", "--symbols", "x,y,z"]);
    expect(out.files).toEqual(["a.ts"]);
    expect(out.symbols).toEqual(["x", "y", "z"]);
  });

  it("collects multi-positional into an array slot", () => {
    const out = parseArgs(arrayTool, ["a.ts", "b.ts", "c.ts"]);
    expect(out.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("accepts repeated array flags (appending)", () => {
    const out = parseArgs(arrayTool, ["a.ts", "--symbols", "x", "--symbols", "y"]);
    expect(out.symbols).toEqual(["x", "y"]);
  });
});
