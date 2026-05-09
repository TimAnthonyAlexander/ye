// Line-level diff for the Edit tool's UI rendering. Computes an LCS over
// the line splits of old_string and new_string, then emits a compressed
// hunk-style sequence: changed lines plus a few lines of unchanged context,
// with longer runs of unchanged lines collapsed into a `gap` marker. This
// is purely cosmetic — the file edit itself is exact-string replace.

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 20;

export type DiffSegmentType = "eq" | "del" | "add" | "gap";

export interface DiffSegment {
    readonly type: DiffSegmentType;
    readonly line: string;
}

export interface EditDiff {
    readonly segments: readonly DiffSegment[];
    readonly truncated: boolean;
}

export interface ComputeDiffOptions {
    readonly context?: number;
    readonly maxLines?: number;
}

interface RawOp {
    readonly type: "eq" | "del" | "add";
    readonly line: string;
}

const computeOps = (oldLines: readonly string[], newLines: readonly string[]): readonly RawOp[] => {
    const m = oldLines.length;
    const n = newLines.length;
    const w = n + 1;
    const dp = new Uint32Array((m + 1) * w);
    for (let i = 1; i <= m; i++) {
        const oi = oldLines[i - 1];
        const row = i * w;
        const rowPrev = (i - 1) * w;
        for (let j = 1; j <= n; j++) {
            if (oi === newLines[j - 1]) {
                dp[row + j] = (dp[rowPrev + (j - 1)] ?? 0) + 1;
            } else {
                const up = dp[rowPrev + j] ?? 0;
                const left = dp[row + (j - 1)] ?? 0;
                dp[row + j] = up > left ? up : left;
            }
        }
    }
    const ops: RawOp[] = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        const oi = i > 0 ? oldLines[i - 1] : undefined;
        const nj = j > 0 ? newLines[j - 1] : undefined;
        if (i > 0 && j > 0 && oi !== undefined && oi === nj) {
            ops.push({ type: "eq", line: oi });
            i -= 1;
            j -= 1;
            continue;
        }
        const up = i > 0 ? (dp[(i - 1) * w + j] ?? 0) : 0;
        const left = j > 0 ? (dp[i * w + (j - 1)] ?? 0) : 0;
        if (j > 0 && (i === 0 || left >= up)) {
            ops.push({ type: "add", line: nj ?? "" });
            j -= 1;
        } else {
            ops.push({ type: "del", line: oi ?? "" });
            i -= 1;
        }
    }
    return ops.reverse();
};

const gapMarker = (count: number): DiffSegment => ({
    type: "gap",
    line: `… ${count} unchanged line${count === 1 ? "" : "s"}`,
});

export const computeEditDiff = (
    oldStr: string,
    newStr: string,
    opts: ComputeDiffOptions = {},
): EditDiff => {
    const context = opts.context ?? DEFAULT_CONTEXT;
    const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    const ops = computeOps(oldStr.split("\n"), newStr.split("\n"));

    const keep = new Array<boolean>(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (op === undefined || op.type === "eq") continue;
        const lo = Math.max(0, i - context);
        const hi = Math.min(ops.length - 1, i + context);
        for (let k = lo; k <= hi; k++) keep[k] = true;
    }

    const segments: DiffSegment[] = [];
    let gapCount = 0;
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (op === undefined) continue;
        if (keep[i]) {
            if (gapCount > 0) {
                segments.push(gapMarker(gapCount));
                gapCount = 0;
            }
            segments.push(op);
        } else {
            gapCount += 1;
        }
    }
    if (gapCount > 0) {
        segments.push(gapMarker(gapCount));
    }

    if (segments.length > maxLines) {
        return { segments: segments.slice(0, maxLines), truncated: true };
    }
    return { segments, truncated: false };
};
