import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TEXT_EXTENSIONS = [".ts", ".tsx", ".md", ".json"];

const textFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            out.push(...textFiles(path));
            continue;
        }
        if (TEXT_EXTENSIONS.some((ext) => path.endsWith(ext))) out.push(path);
    }
    return out;
};

// Markdown counts: YE.md was committed as a binary blob because a NUL reached
// it, which made the whole docs rewrite unreviewable in git.
const trackedTextFiles = (): string[] => [
    ...textFiles("src"),
    ...readdirSync(".")
        .filter((entry) => TEXT_EXTENSIONS.some((ext) => entry.endsWith(ext)))
        .filter((entry) => statSync(entry).isFile()),
];

// A raw control byte in a source file makes git treat it as binary: diffs
// become "Bin N -> M bytes" and review is impossible. Separators like NUL must
// be written as an escape. Two independent changes have regressed this.
const isDisallowed = (byte: number): boolean =>
    byte < 9 || (byte > 13 && byte < 32) || byte === 127;

describe("source hygiene", () => {
    test("no raw control bytes in any tracked text file", () => {
        const offenders: string[] = [];
        for (const path of trackedTextFiles()) {
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
