import { homedir } from "node:os";

// Render an absolute path in user-friendly form for display: relative to cwd
// when inside it, ~-prefixed when inside the home dir, otherwise unchanged.
// Tool args still travel as absolute paths — this is display-only.
export const prettyPath = (absPath: string, cwd: string = process.cwd()): string => {
    if (typeof absPath !== "string" || absPath.length === 0) return absPath;
    if (absPath === cwd) return ".";
    if (absPath.startsWith(`${cwd}/`)) return absPath.slice(cwd.length + 1);
    const home = homedir();
    if (absPath === home) return "~";
    if (absPath.startsWith(`${home}/`)) return `~${absPath.slice(home.length)}`;
    return absPath;
};
