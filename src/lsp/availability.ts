import { readFileSync } from "node:fs";
import { detectLspServers } from "../config/detect.ts";
import { CONFIG_FILE } from "../config/paths.ts";
import { resolveProjectRoot } from "../storage/project.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const declaresLspServers = (raw: unknown): boolean => {
    if (!isRecord(raw)) return false;
    const lsp = raw["lsp"];
    if (!isRecord(lsp) || lsp["enabled"] !== true) return false;
    const servers = lsp["servers"];
    return isRecord(servers) && Object.keys(servers).length > 0;
};

const available = (raw: unknown): boolean => {
    const lsp = isRecord(raw) ? raw["lsp"] : undefined;
    if (isRecord(lsp) && lsp["enabled"] === false) return false;
    const servers = isRecord(lsp) ? lsp["servers"] : undefined;
    if (isRecord(servers) && Object.keys(servers).length > 0) return true;
    if (isRecord(raw) && raw["autoDetect"] === false) return false;
    return Object.keys(detectLspServers(resolveProjectRoot())).length > 0;
};

let cached: boolean | undefined;

// The tool registry has no Config handle — assembleToolPool() builds the pool
// from listTools() alone — so availability is read from the config file
// directly and resolved against the project root, once per process.
// Registering the navigation tools and then failing every call would cost the
// model turns it can never spend usefully.
export const lspToolsAvailable = (): boolean => {
    if (cached === undefined) {
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
        } catch {
            raw = undefined;
        }
        cached = available(raw);
    }
    return cached;
};
