import { checkDomain } from "../webShared/domainGate.ts";
import type { WebToolsConfig } from "../../config/index.ts";

const ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&#x27;": "'",
    "&nbsp;": " ",
};

const decodeEntities = (s: string): string =>
    s.replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] ?? m);

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, "");

// DDG's lite endpoint wraps the actual destination URL in a redirector:
//   /l/?uddg=<url-encoded>&rut=...
// Unwrap to the real URL when present.
const unwrapDdgRedirect = (raw: string): string => {
    try {
        const u = new URL(raw, ENDPOINT);
        if (u.pathname === "/l/" || u.pathname.endsWith("/l/")) {
            const inner = u.searchParams.get("uddg");
            if (inner) return decodeURIComponent(inner);
        }
        return u.toString();
    } catch {
        return raw;
    }
};

export interface SearchResult {
    readonly title: string;
    readonly url: string;
}

export interface DdgSearchArgs {
    readonly query: string;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
    readonly maxBytes: number;
    readonly limit: number;
    readonly config?: WebToolsConfig;
    readonly signal: AbortSignal;
}

// Parses `<a class="result__a" href="...">title</a>` from DDG's HTML lite
// endpoint. The `result__a` class has been stable for years but is the obvious
// hazard if DDG ever rewrites their markup. If parsing yields zero results we
// surface a clear error rather than silently returning empty.
const RESULT_LINK_RE =
    /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

export const runDuckDuckGoSearch = async (
    a: DdgSearchArgs,
): Promise<{ ok: true; results: readonly SearchResult[] } | { ok: false; error: string }> => {
    const url = `${ENDPOINT}?q=${encodeURIComponent(a.query)}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "user-agent": USER_AGENT,
                "content-type": "application/x-www-form-urlencoded",
                accept: "text/html",
            },
            body: `q=${encodeURIComponent(a.query)}`,
            signal: a.signal,
        });
    } catch (err) {
        if (a.signal.aborted) return { ok: false, error: "aborted" };
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `network: ${msg}` };
    }

    if (!res.ok) {
        return { ok: false, error: `duckduckgo http ${res.status}` };
    }

    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: "duckduckgo: empty body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > a.maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    /* ignore */
                }
                return { ok: false, error: `duckduckgo response > ${a.maxBytes} bytes` };
            }
            chunks.push(value);
        }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(merged);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(RESULT_LINK_RE)) {
        const href = unwrapDdgRedirect(decodeEntities(m[1] ?? ""));
        const title = decodeEntities(stripTags(m[2] ?? "")).trim();
        if (!href || !title) continue;

        let host: string;
        try {
            host = new URL(href).hostname;
        } catch {
            continue;
        }
        const gate = checkDomain({
            host,
            ...(a.config ? { config: a.config } : {}),
            ...(a.allowedDomains ? { allowList: a.allowedDomains } : {}),
            ...(a.blockedDomains ? { blockList: a.blockedDomains } : {}),
        });
        if (!gate.ok) continue;

        if (seen.has(href)) continue;
        seen.add(href);
        results.push({ title, url: href });
        if (results.length >= a.limit) break;
    }

    if (results.length === 0) {
        return {
            ok: false,
            error: "duckduckgo returned no parseable results — DDG may have changed their markup, or the query was empty",
        };
    }
    return { ok: true, results };
};
