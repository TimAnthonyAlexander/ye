/**
 * Tests for input.tsx pure logic.
 *
 * Ink 5 renders to terminal output and does not ship a headless test renderer.
 * We test the exported pure functions directly using Bun's built-in test runner.
 */

import { describe, expect, test } from "bun:test";
import {
  buildVisualRows,
  findCursorRow,
  nextWordStart,
  normalizePaste,
  prevWordStart,
} from "./input.tsx";

describe("normalizePaste", () => {
  test("converts CRLF to LF", () => {
    expect(normalizePaste("hello\r\nworld")).toBe("hello\nworld");
  });

  test("converts lone CR to LF", () => {
    expect(normalizePaste("hello\rworld")).toBe("hello\nworld");
  });

  test("leaves LF unchanged", () => {
    expect(normalizePaste("hello\nworld")).toBe("hello\nworld");
  });

  test("handles mixed line endings", () => {
    expect(normalizePaste("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  test("returns empty string for empty input", () => {
    expect(normalizePaste("")).toBe("");
  });
});

describe("prevWordStart", () => {
  test("returns 0 when cursor is at start", () => {
    expect(prevWordStart("hello world", 0)).toBe(0);
  });

  test("skips back to previous word start", () => {
    // "hello world", cursor at 7 (between words)
    expect(prevWordStart("hello world", 7)).toBe(6);
  });

  test("skips past spaces to find word start", () => {
    // "hello   world", cursor at 10 (at 'w')
    expect(prevWordStart("hello   world", 10)).toBe(8);
  });

  test("finds start of current word when cursor is mid-word", () => {
    // "  hello", cursor at 4 (first 'l') — word starts at index 2 ('h')
    expect(prevWordStart("  hello", 4)).toBe(2);
  });

  test("handles newline as word separator", () => {
    expect(prevWordStart("hello\nworld", 7)).toBe(6);
  });
});

describe("nextWordStart", () => {
  test("returns length when cursor at end", () => {
    expect(nextWordStart("hello", 5)).toBe(5);
  });

  test("finds next word start from middle of word", () => {
    // "hello world", cursor at 2 (in "hello")
    expect(nextWordStart("hello world", 2)).toBe(6);
  });

  test("skips spaces to find next word", () => {
    // "hello   world", cursor at 5 (at first space)
    expect(nextWordStart("hello   world", 5)).toBe(8);
  });

  test("returns length when no next word", () => {
    expect(nextWordStart("hello   ", 5)).toBe(8);
  });
});

describe("buildVisualRows", () => {
  test("splits on newlines", () => {
    const rows = buildVisualRows("a\nb\nc", 10);
    expect(rows.length).toBe(3);
    expect(rows[0]!.text).toBe("a");
    expect(rows[1]!.text).toBe("b");
    expect(rows[2]!.text).toBe("c");
  });

  test("preserves empty rows for blank lines", () => {
    const rows = buildVisualRows("a\n\nb", 10);
    expect(rows.length).toBe(3);
    expect(rows[1]!.text).toBe("");
  });

  test("wraps long lines at width boundary", () => {
    const rows = buildVisualRows("abcdefghij", 3);
    // 10 chars, width 3 → 4 rows: "abc", "def", "ghi", "j"
    expect(rows.length).toBe(4);
    expect(rows[0]!.text).toBe("abc");
    expect(rows[1]!.text).toBe("def");
    expect(rows[2]!.text).toBe("ghi");
    expect(rows[3]!.text).toBe("j");
  });

  test("tracks startInValue offsets", () => {
    const rows = buildVisualRows("abc\ndef", 2);
    // "abc" is 3 chars, wraps at 2 → rows: "ab" (start=0), "c" (start=2)
    // then newline at offset 3, "def" at offset 4: "de" (start=4), "f" (start=6)
    expect(rows[0]!.startInValue).toBe(0);
    expect(rows[1]!.startInValue).toBe(2);
    expect(rows[2]!.startInValue).toBe(4);
    expect(rows[3]!.startInValue).toBe(6);
  });

  test("returns a single empty row for empty string", () => {
    const rows = buildVisualRows("", 10);
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toBe("");
    expect(rows[0]!.startInValue).toBe(0);
  });

  test("clamps width to at least 1", () => {
    const rows = buildVisualRows("ab", 0);
    // width 0 becomes 1, so each char on its own row
    expect(rows.length).toBe(2);
    expect(rows[0]!.text).toBe("a");
    expect(rows[1]!.text).toBe("b");
  });
});

describe("findCursorRow", () => {
  test("finds the row containing the cursor offset", () => {
    const rows = buildVisualRows("abc\ndef", 2);
    // rows: "ab" (0-1), "c" (2), "de" (4-5), "f" (6)
    expect(findCursorRow(rows, 0)).toBe(0);
    expect(findCursorRow(rows, 1)).toBe(0);
    expect(findCursorRow(rows, 2)).toBe(1);
    expect(findCursorRow(rows, 3)).toBe(1);
    expect(findCursorRow(rows, 4)).toBe(2);
    expect(findCursorRow(rows, 6)).toBe(3);
  });

  test("returns 0 for empty rows array (should not happen in practice)", () => {
    expect(findCursorRow([], 0)).toBe(0);
  });

  test("cursor beyond last row returns last row", () => {
    const rows = buildVisualRows("hello", 10);
    expect(findCursorRow(rows, 100)).toBe(0);
  });
});
