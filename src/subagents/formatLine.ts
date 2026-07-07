import type { Event } from "../pipeline/events.ts";
import { prettyPath } from "../ui/path.ts";

const ARG_CLIP = 60;

const clip = (s: string): string => (s.length > ARG_CLIP ? s.slice(0, ARG_CLIP) + "…" : s);

export const formatChildLine = (evt: Event, cwd: string): string | null => {
    if (evt.type !== "tool.start") return null;
    const a = (evt.args ?? {}) as Record<string, unknown>;
    const path = typeof a["path"] === "string" ? (a["path"] as string) : "";
    const pattern = typeof a["pattern"] === "string" ? (a["pattern"] as string) : "";
    const command = typeof a["command"] === "string" ? (a["command"] as string) : "";
    switch (evt.name) {
        case "Read":
        case "Edit":
        case "Write":
            return path ? `${evt.name} ${clip(prettyPath(path, cwd))}` : evt.name;
        case "Glob":
            return pattern ? `Glob ${clip(pattern)}` : "Glob";
        case "Grep":
            return pattern ? `Grep "${clip(pattern)}"` : "Grep";
        case "Bash":
            return command ? `Bash ${clip(command)}` : "Bash";
        default:
            return evt.name;
    }
};
