import { describe, expect, test } from "bun:test";
import { moveSelection } from "./subagentTabBar.tsx";
import { windowFromBottom } from "./subagentTranscript.tsx";

const TABS = ["main", "a1", "a2"];

describe("moveSelection", () => {
    test("down walks the list one agent at a time", () => {
        expect(moveSelection(TABS, "main", "down")).toBe("a1");
        expect(moveSelection(TABS, "a1", "down")).toBe("a2");
    });

    test("up walks back the same way", () => {
        expect(moveSelection(TABS, "a2", "up")).toBe("a1");
        expect(moveSelection(TABS, "a1", "up")).toBe("main");
    });

    // The one asymmetry, and it is deliberate: ↑ is the way out, ↓ is not.
    test("up off the top row hands the keys back", () => {
        expect(moveSelection(TABS, "main", "up")).toBeNull();
    });

    test("down off the bottom row stays put instead of wrapping to main", () => {
        expect(moveSelection(TABS, "a2", "down")).toBe("a2");
    });

    test("with no agents running, main is the only row and up still exits", () => {
        expect(moveSelection(["main"], "main", "down")).toBe("main");
        expect(moveSelection(["main"], "main", "up")).toBeNull();
    });

    test("a selection that no longer exists is treated as the top row", () => {
        expect(moveSelection(TABS, "gone", "down")).toBe("a1");
        expect(moveSelection(TABS, "gone", "up")).toBeNull();
    });
});

describe("windowFromBottom", () => {
    // The transcript no longer scrolls, so it is only ever called at offset 0:
    // the newest items that fit, never a scrolled-back slice.
    test("takes the newest items that fit the line budget", () => {
        expect(windowFromBottom([5, 5, 5, 5], 0, 12)).toEqual({ start: 2, end: 4 });
    });

    test("shows everything when it all fits", () => {
        expect(windowFromBottom([2, 2, 2], 0, 100)).toEqual({ start: 0, end: 3 });
    });

    test("one item taller than the viewport still renders", () => {
        expect(windowFromBottom([500], 0, 10)).toEqual({ start: 0, end: 1 });
    });

    test("an empty transcript yields an empty window", () => {
        expect(windowFromBottom([], 0, 40)).toEqual({ start: 0, end: 0 });
    });
});
