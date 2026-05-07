import type { WebToolsConfig } from "../../config/index.ts";

// Built-in blocklist. User config wins on conflict (a user allow lifts a
// built-in block). Keep tight: hostile / hostile-by-reputation hosts only;
// the user's blockedDomains list is the right place for personal preferences.
const BUILTIN_BLOCKED: ReadonlySet<string> = new Set(["phishtank.com", "malware.wicar.org"]);

const stripWww = (host: string): string => (host.startsWith("www.") ? host.slice(4) : host);

const hostMatches = (host: string, pattern: string): boolean => {
    const h = stripWww(host.toLowerCase());
    const p = stripWww(pattern.toLowerCase());
    return h === p || h.endsWith(`.${p}`);
};

export interface GateInput {
    readonly host: string;
    readonly config?: WebToolsConfig;
    // Per-call lists (e.g. WebSearch's allowed_domains arg) layered on top of
    // user config. Both lists merge with the same semantics: allowList is an
    // intersection filter; blockList adds to denials.
    readonly allowList?: readonly string[];
    readonly blockList?: readonly string[];
}

export type GateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const checkDomain = (input: GateInput): GateResult => {
    const host = input.host.toLowerCase();
    if (host.length === 0) {
        return { ok: false, reason: "empty host" };
    }

    const userAllow = input.config?.allowedDomains ?? [];
    const callAllow = input.allowList ?? [];
    const allowList = [...userAllow, ...callAllow];

    const userBlock = input.config?.blockedDomains ?? [];
    const callBlock = input.blockList ?? [];

    if (callBlock.some((p) => hostMatches(host, p))) {
        return { ok: false, reason: `host blocked by call: ${host}` };
    }
    if (userBlock.some((p) => hostMatches(host, p))) {
        return { ok: false, reason: `host blocked by config: ${host}` };
    }

    const allowed = allowList.length === 0 || allowList.some((p) => hostMatches(host, p));
    if (!allowed) {
        return { ok: false, reason: `host not in allow-list: ${host}` };
    }

    if (allowList.some((p) => hostMatches(host, p))) {
        return { ok: true };
    }

    for (const blocked of BUILTIN_BLOCKED) {
        if (hostMatches(host, blocked)) {
            return { ok: false, reason: `host blocked by built-in list: ${host}` };
        }
    }

    return { ok: true };
};

export const __test = { hostMatches, BUILTIN_BLOCKED };
