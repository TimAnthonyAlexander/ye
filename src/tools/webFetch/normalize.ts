export const MAX_URL_LENGTH = 2000;

export type NormalizeResult =
    | { readonly ok: true; readonly url: string; readonly host: string }
    | { readonly ok: false; readonly error: string };

// Canonicalise a URL the way the Claude Code WebFetch pipeline does:
//   - HTTPS upgrade for plain HTTP.
//   - Strip user:pass@ credentials.
//   - Reject anything over MAX_URL_LENGTH chars (oversized URLs are usually
//     attacker payloads or accidentally-pasted dumps).
//   - Reject non-http(s) schemes (file:, data:, javascript:, etc.).
export const normalizeUrl = (raw: string): NormalizeResult => {
    if (raw.length === 0) return { ok: false, error: "url is empty" };
    if (raw.length > MAX_URL_LENGTH) {
        return { ok: false, error: `url exceeds ${MAX_URL_LENGTH} chars` };
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, error: "url is not a valid absolute URL" };
    }

    if (parsed.protocol === "http:") {
        parsed.protocol = "https:";
    }
    if (parsed.protocol !== "https:") {
        return { ok: false, error: `unsupported scheme: ${parsed.protocol}` };
    }

    parsed.username = "";
    parsed.password = "";

    return { ok: true, url: parsed.toString(), host: parsed.hostname };
};
