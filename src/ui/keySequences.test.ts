import { describe, expect, test } from "bun:test";
import { CTRL_A, CTRL_E, readlineForNavKey } from "./keySequences.ts";

describe("readlineForNavKey", () => {
    test("maps every known Home sequence to Ctrl+A", () => {
        for (const seq of ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"]) {
            expect(readlineForNavKey(seq)).toBe(CTRL_A);
        }
    });

    test("maps every known End sequence to Ctrl+E", () => {
        for (const seq of ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]) {
            expect(readlineForNavKey(seq)).toBe(CTRL_E);
        }
    });

    test("leaves arrows and other sequences alone", () => {
        expect(readlineForNavKey("\x1b[A")).toBeNull();
        expect(readlineForNavKey("\x1b[D")).toBeNull();
        expect(readlineForNavKey("\x1b[3~")).toBeNull();
        expect(readlineForNavKey("\x1b[5~")).toBeNull();
        expect(readlineForNavKey("a")).toBeNull();
        expect(readlineForNavKey("")).toBeNull();
    });
});
