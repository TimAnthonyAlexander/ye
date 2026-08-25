import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const expandHome = (path: string): string => {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return join(homedir(), path.slice(2));
    return path;
};

export const toAbsolutePath = (path: string, cwd: string): string => {
    const expanded = expandHome(path);
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};

const PATH_ARG_TOOLS: ReadonlySet<string> = new Set(["Read", "Edit", "Write", "Glob", "Grep"]);

// The permission gate and the tool must resolve a relative path identically, or
// a deny rule could be evaluated against a different file than the one written.
// Normalising once, before the gate, is what keeps them in agreement. It runs
// after applyArgAliases, so `file_path` is already `path` by this point.
export const normalizePathArg = <T extends { readonly name: string; readonly args: unknown }>(
    call: T,
    cwd: string,
): T => {
    if (!PATH_ARG_TOOLS.has(call.name)) return call;
    const args = call.args;
    if (typeof args !== "object" || args === null) return call;
    const raw = (args as Record<string, unknown>)["path"];
    if (typeof raw !== "string" || raw === "") return call;
    const absolute = toAbsolutePath(raw, cwd);
    if (absolute === raw) return call;
    return { ...call, args: { ...(args as Record<string, unknown>), path: absolute } };
};
