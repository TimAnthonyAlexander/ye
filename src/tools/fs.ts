import { chmod, rename, stat } from "node:fs/promises";

interface AtomicWriteOptions {
    // Copy the existing file's permission bits onto the new content.
    // Skip on brand-new files — the existing path is stat'd, so it must exist.
    readonly preserveMode?: boolean;
}

// Atomic file write: write to a temp file in the same directory, then rename.
// Same-volume rename is atomic on POSIX, so a crashed process never leaves a
// half-written file at the target path.
export const atomicWrite = async (
    path: string,
    content: string,
    opts: AtomicWriteOptions = {},
): Promise<void> => {
    const tmp = `${path}.ye-${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, content);
    if (opts.preserveMode) {
        const { mode } = await stat(path);
        await chmod(tmp, mode & 0o777);
    }
    await rename(tmp, path);
};

// Stable string fingerprint of a file's contents. Used by the turn-local
// read-before-edit invariant to detect drift between Read and Edit/Write.
export const hashContent = (content: string): string => Bun.hash(content).toString();
