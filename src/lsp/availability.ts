import { readFileSync } from "node:fs";
import { CONFIG_FILE } from "../config/paths.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const declaresLspServers = (raw: unknown): boolean => {
    if (!isRecord(raw)) return false;
    const lsp = raw["lsp"];
    if (!isRecord(lsp) || lsp["enabled"] !== true) return false;
    const servers = lsp["servers"];
    return isRecord(servers) && Object.keys(servers).length > 0;
};

let cached: boolean | undefined;

// The tool registry has no Config handle — assembleToolPool() builds the pool
// from listTools() alone — so availability is read from the config file
// directly, once per process. Registering the navigation tools and then failing
// every call would cost the model turns it can never spend usefully.
export const lspToolsAvailable = (): boolean => {
    if (cached === undefined) {
        try {
            const raw: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
            cached = declaresLspServers(raw);
        } catch {
            cached = false;
        }
    }
    return cached;
};
