/**
 * Tests for permissionPrompt.tsx pure logic.
 *
 * Ink 5 renders to terminal output and does not ship a headless test renderer.
 * We test the exported pure functions directly using Bun's built-in test runner.
 */

import { describe, expect, test } from "bun:test";
import {
  previewBash,
  previewEdit,
  previewWrite,
  renderArgs,
} from "./permissionPrompt.tsx";

describe("previewBash", () => {
  test("formats a command with $ prefix", () => {
    expect(previewBash({ command: "rm -rf /tmp/foo" })).toBe(
      "$ rm -rf /tmp/foo",
    );
  });

  test("returns (unknown command) for empty args", () => {
    expect(previewBash({})).toBe("(unknown command)");
  });

  test("returns (unknown command) when command is empty string", () => {
    expect(previewBash({ command: "" })).toBe("(unknown command)");
  });
});

describe("previewEdit", () => {
  test("includes path and old_string", () => {
    const result = previewEdit({
      path: "/foo/bar.ts",
      old_string: "hello world",
    });
    expect(result).toContain("/foo/bar.ts");
    expect(result).toContain("old: hello world");
  });

  test("uses ? when path is missing", () => {
    const result = previewEdit({ old_string: "hello world" });
    expect(result).toContain("?");
    expect(result).toContain("old: hello world");
  });

  test("truncates old_string over 80 chars and appends ellipsis", () => {
    const long = "a".repeat(100);
    const result = previewEdit({ path: "/x.ts", old_string: long });
    expect(result).toContain("old: " + "a".repeat(80) + "…");
  });

  test("collapses whitespace in old_string", () => {
    const result = previewEdit({
      path: "/x.ts",
      old_string: "hello\nworld  test",
    });
    expect(result).toContain("old: hello world test");
  });
});

describe("previewWrite", () => {
  test("returns pretty-pathed path", () => {
    const result = previewWrite({ path: "/foo/bar.ts" });
    // prettyPath leaves /foo/bar.ts as-is (not in cwd or home)
    expect(result).toBe("/foo/bar.ts");
  });

  test("returns ? when path is missing", () => {
    expect(previewWrite({})).toBe("?");
  });
});

describe("renderArgs", () => {
  test("Bash delegates to previewBash", () => {
    expect(renderArgs("Bash", { command: "ls" })).toBe("$ ls");
  });

  test("Edit delegates to previewEdit", () => {
    const result = renderArgs("Edit", { path: "x", old_string: "y" });
    expect(result).toContain("x");
    expect(result).toContain("old: y");
  });

  test("Write delegates to previewWrite", () => {
    expect(renderArgs("Write", { path: "/x" })).toBe("/x");
  });

  test("unknown tool returns JSON.stringify", () => {
    expect(renderArgs("Unknown", { x: 1 })).toBe('{"x":1}');
  });

  test("unknown tool with circular ref falls back to String()", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    // JSON.stringify throws on circular refs; fallback is String()
    expect(renderArgs("Unknown", obj)).toBe("[object Object]");
  });
});
