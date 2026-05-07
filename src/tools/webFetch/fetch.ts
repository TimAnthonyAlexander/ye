export type ContentKind = "html" | "text" | "json" | "markdown" | "binary";

export interface FetchSuccess {
    readonly ok: true;
    readonly content: string;
    readonly kind: ContentKind;
    readonly finalUrl: string;
}

export interface FetchRedirect {
    readonly ok: true;
    readonly redirectTo: string;
    readonly kind: "redirect";
}

export type FetchOutcome =
    | FetchSuccess
    | FetchRedirect
    | { readonly ok: false; readonly error: string };

const MAX_REDIRECTS = 5;
const USER_AGENT = "Ye/0.1 (+https://github.com/tim-ye/ye)";

const classify = (contentType: string | null): ContentKind => {
    const ct = (contentType ?? "").toLowerCase();
    if (ct.includes("text/html")) return "html";
    if (ct.includes("application/xhtml")) return "html";
    if (ct.includes("application/json") || ct.includes("+json")) return "json";
    if (ct.includes("text/markdown")) return "markdown";
    if (ct.startsWith("text/")) return "text";
    return "binary";
};

const sameHost = (a: string, b: string): boolean => {
    try {
        return new URL(a).hostname === new URL(b).hostname;
    } catch {
        return false;
    }
};

const readCappedBody = async (res: Response, maxBytes: number): Promise<string | null> => {
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    /* ignore */
                }
                return null;
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
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
};

export interface FetchOptions {
    readonly url: string;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
}

// Manual fetch loop. Anthropic's WebFetch follows same-host redirects but
// returns metadata for cross-host ones so the model has to opt back in. We
// match that posture and add an explicit byte cap on the body read so a
// malicious server can't stream us 10GB.
export const fetchUrl = async (opts: FetchOptions): Promise<FetchOutcome> => {
    let current = opts.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let res: Response;
        try {
            res = await fetch(current, {
                method: "GET",
                redirect: "manual",
                signal: opts.signal,
                headers: {
                    "user-agent": USER_AGENT,
                    accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
                },
            });
        } catch (err) {
            if (opts.signal.aborted) return { ok: false, error: "aborted" };
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `network: ${msg}` };
        }

        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) return { ok: false, error: `${res.status} redirect with no Location header` };
            const next = new URL(loc, current).toString();
            if (!sameHost(current, next)) {
                return { ok: true, redirectTo: next, kind: "redirect" };
            }
            current = next;
            continue;
        }

        if (!res.ok) {
            return { ok: false, error: `http ${res.status} ${res.statusText}` };
        }

        const kind = classify(res.headers.get("content-type"));
        if (kind === "binary") {
            return {
                ok: false,
                error: `unsupported content type: ${res.headers.get("content-type") ?? "unknown"}`,
            };
        }
        const body = await readCappedBody(res, opts.maxBytes);
        if (body === null) {
            return { ok: false, error: `response exceeded ${opts.maxBytes} bytes` };
        }
        return { ok: true, content: body, kind, finalUrl: current };
    }
    return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})` };
};
