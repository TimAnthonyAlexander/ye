import { describe, expect, test } from "bun:test";
import { windowStart } from "./slashPicker.tsx";

describe("windowStart", () => {
    test("does not scroll when everything fits", () => {
        expect(windowStart(3, 0, 5)).toBe(0);
        expect(windowStart(3, 2, 5)).toBe(0);
        expect(windowStart(5, 4, 5)).toBe(0);
    });

    test("keeps the selection at the top until it passes the midpoint", () => {
        expect(windowStart(10, 0, 5)).toBe(0);
        expect(windowStart(10, 1, 5)).toBe(0);
        expect(windowStart(10, 2, 5)).toBe(0);
    });

    test("centres the selection once scrolling starts", () => {
        expect(windowStart(10, 3, 5)).toBe(1);
        expect(windowStart(10, 5, 5)).toBe(3);
    });

    test("clamps to the last full window at the bottom", () => {
        expect(windowStart(10, 8, 5)).toBe(5);
        expect(windowStart(10, 9, 5)).toBe(5);
    });

    test("every index is reachable inside the window it produces", () => {
        const total = 21;
        const max = 5;
        for (let active = 0; active < total; active++) {
            const start = windowStart(total, active, max);
            expect(start).toBeGreaterThanOrEqual(0);
            expect(start + max).toBeLessThanOrEqual(total);
            expect(active).toBeGreaterThanOrEqual(start);
            expect(active).toBeLessThan(start + max);
        }
    });
});
