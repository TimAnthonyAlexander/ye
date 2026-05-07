import type { PermissionMode } from "../config/index.ts";

export const MODE_CYCLE: readonly PermissionMode[] = ["NORMAL", "AUTO", "PLAN"];

export const cycleMode = (current: PermissionMode): PermissionMode => {
    const i = MODE_CYCLE.indexOf(current);
    const next = MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
    return next ?? "NORMAL";
};

export const modeColor = (mode: PermissionMode): string => {
    switch (mode) {
        case "AUTO":
            return "yellow";
        case "PLAN":
            return "magenta";
        case "NORMAL":
            return "cyan";
    }
};
