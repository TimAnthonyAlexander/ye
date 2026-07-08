/**
 * Tests for statusBar.tsx pure logic.
 *
 * Ink 5 renders to terminal output and does not ship a headless test renderer.
 * We test the exported pure functions directly using Bun's built-in test runner.
 */

import { describe, expect, test } from "bun:test";
import { formatK, formatPct, formatUsd, usageColor } from "./statusBar.tsx";

describe("usageColor", () => {
    test("green for < 50%", () => {
        expect(usageColor(0)).toBe("green");
        expect(usageColor(25)).toBe("green");
        expect(usageColor(49.9)).toBe("green");
    });

    test("yellow for 50-74%", () => {
        expect(usageColor(50)).toBe("yellow");
        expect(usageColor(74.9)).toBe("yellow");
    });

    test("orange for 75-89%", () => {
        expect(usageColor(75)).toBe("#ff8800");
        expect(usageColor(89.9)).toBe("#ff8800");
    });

    test("red for >= 90%", () => {
        expect(usageColor(90)).toBe("red");
        expect(usageColor(100)).toBe("red");
    });
});

describe("formatPct", () => {
    test("returns 0% for values below 1", () => {
        expect(formatPct(0)).toBe("0%");
        expect(formatPct(0.5)).toBe("0%");
        expect(formatPct(0.99)).toBe("0%");
    });

    test("rounds to nearest integer percent", () => {
        expect(formatPct(1)).toBe("1%");
        expect(formatPct(42.3)).toBe("42%");
        expect(formatPct(42.7)).toBe("43%");
        expect(formatPct(99.5)).toBe("100%");
    });
});

describe("formatK", () => {
    test("returns plain number for < 1000", () => {
        expect(formatK(0)).toBe("0");
        expect(formatK(500)).toBe("500");
        expect(formatK(999)).toBe("999");
    });

    test("one decimal K for 1K-10K", () => {
        expect(formatK(1000)).toBe("1.0K");
        expect(formatK(5500)).toBe("5.5K");
        expect(formatK(9999)).toBe("10.0K");
    });

    test("rounded K for 10K-1M", () => {
        expect(formatK(10000)).toBe("10K");
        expect(formatK(12345)).toBe("12K");
        expect(formatK(999000)).toBe("999K");
    });

    test("one decimal M for 1M-10M", () => {
        expect(formatK(1000000)).toBe("1.0M");
        expect(formatK(2500000)).toBe("2.5M");
    });

    test("rounded M for >= 10M", () => {
        expect(formatK(10000000)).toBe("10M");
        expect(formatK(12300000)).toBe("12M");
    });
});

describe("formatUsd", () => {
    test("4 decimal places for < $0.01", () => {
        expect(formatUsd(0.005)).toBe("$0.0050");
        expect(formatUsd(0.009)).toBe("$0.0090");
    });

    test("3 decimal places for < $1", () => {
        expect(formatUsd(0.01)).toBe("$0.010");
        expect(formatUsd(0.5)).toBe("$0.500");
        expect(formatUsd(0.999)).toBe("$0.999");
    });

    test("2 decimal places for < $100", () => {
        expect(formatUsd(1)).toBe("$1.00");
        expect(formatUsd(42.5)).toBe("$42.50");
        expect(formatUsd(99.99)).toBe("$99.99");
    });

    test("rounded dollar for >= $100", () => {
        expect(formatUsd(100)).toBe("$100");
        expect(formatUsd(500.5)).toBe("$501");
        expect(formatUsd(10000)).toBe("$10000");
    });
});
