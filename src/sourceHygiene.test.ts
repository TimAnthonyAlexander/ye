import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            out.push(...sourceFiles(path));
            continue;
        }
        if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
    }
    return out;
};

// A raw control byte in a source file makes git treat it as binary: diffs
// become "Bin N -> M bytes" and review is impossible. Separators like NUL must
// be written as an escape. Two independent changes have regressed this.
const isDisallowed = (byte: number): boolean =>
    byte < 9 || (byte > 13 && byte < 32) || byte === 127;

describe("source hygiene", () => {
    test("no raw control bytes in any source file", () => {
        const offenders: string[] = [];
        for (const path of sourceFiles("src")) {
            const bytes = readFileSync(path);
            for (let i = 0; i < bytes.length; i++) {
                const byte = bytes[i];
                if (byte !== undefined && isDisallowed(byte)) {
                    offenders.push(`${path} at byte ${i} (0x${byte.toString(16)})`);
                    break;
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
