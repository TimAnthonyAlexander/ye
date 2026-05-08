import { checkDomain } from "../webShared/domainGate.ts";
import type { WebToolsConfig } from "../../config/index.ts";
import type { SearchResult } from "./duckduckgo.ts";

const ENDPOINT = "https://search.brave.com/search";
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

export interface BraveSearchArgs {
    readonly query: string;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
    readonly maxBytes: number;
    readonly limit: number;
    readonly config?: WebToolsConfig;
    readonly signal: AbortSignal;
}

// Brave wraps each web result in a div whose class is Svelte-hashed but whose
// `data-type="web"` attribute is the stable semantic anchor. The first <a> in
// that block is the destination URL (no redirector — unlike DDG), and the
// title text is in `class="search-snippet-title"` with a `title=""` attribute
// that's already entity-encoded but never truncated. Anchoring on these two
// stable hooks survives Svelte hash rotations between deploys.
const RESULT_RE =
    /data-type="web"[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[\s\S]*?\bsearch-snippet-title\b[^>]*title="([^"]+)"/g;

// Cloudflare interstitials and Brave's own bot-challenge page. Any of these in
// the body means we never reached the result list — surface that distinctly so
// the chain caller knows to retry on the next provider.
const ANTIBOT_MARKERS = [
    "cf-challenge",
    "challenge-platform",
    "Just a moment",
    "Verifying you are human",
    "Please verify you are a human",
    "captcha-bypass",
];

export const runBraveSearch = async (
    a: BraveSearchArgs,
): Promise<{ ok: true; results: readonly SearchResult[] } | { ok: false; error: string }> => {
    const url = `${ENDPOINT}?q=${encodeURIComponent(a.query)}&source=web`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: "GET",
            headers: {
                "user-agent": USER_AGENT,
                accept: "text/html,application/xhtml+xml",
                "accept-language": "en-US,en;q=0.9",
            },
            signal: a.signal,
        });
    } catch (err) {
        if (a.signal.aborted) return { ok: false, error: "aborted" };
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `brave network: ${msg}` };
    }

    if (res.status === 429 || res.status === 403) {
        return { ok: false, error: `brave rate-limited (http ${res.status})` };
    }
    if (!res.ok) {
        return { ok: false, error: `brave http ${res.status}` };
    }

    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: "brave: empty body" };
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
                return { ok: false, error: `brave response > ${a.maxBytes} bytes` };
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

    if (ANTIBOT_MARKERS.some((m) => html.includes(m))) {
        return { ok: false, error: "brave served an anti-bot challenge page" };
    }

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(RESULT_RE)) {
        const href = decodeEntities(m[1] ?? "");
        const title = decodeEntities(m[2] ?? "").trim();
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
            error: "brave returned no parseable results — markup may have shifted",
        };
    }
    return { ok: true, results };
};
