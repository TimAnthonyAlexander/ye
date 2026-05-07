import { rename } from "node:fs/promises";

// Atomic file write: write to a temp file in the same directory, then rename.
// Same-volume rename is atomic on POSIX, so a crashed process never leaves a
// half-written file at the target path.
export const atomicWrite = async (path: string, content: string): Promise<void> => {
    const tmp = `${path}.ye-${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, content);
    await rename(tmp, path);
};

// Stable string fingerprint of a file's contents. Used by the turn-local
// read-before-edit invariant to detect drift between Read and Edit/Write.
export const hashContent = (content: string): string => Bun.hash(content).toString();
