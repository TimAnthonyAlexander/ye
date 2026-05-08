interface ParsedArgs {
    readonly positional: readonly string[];
    readonly raw: string;
}

export const parseArgs = (raw: string): ParsedArgs => {
    const out: string[] = [];
    let buf = "";
    let inSingle = false;
    let inDouble = false;
    let escape = false;
    let active = false;

    for (const ch of raw) {
        if (escape) {
            buf += ch;
            active = true;
            escape = false;
            continue;
        }
        if (!inSingle && !inDouble && ch === "\\") {
            escape = true;
            continue;
        }
        if (!inDouble && ch === "'") {
            inSingle = !inSingle;
            active = true;
            continue;
        }
        if (!inSingle && ch === '"') {
            inDouble = !inDouble;
            active = true;
            continue;
        }
        if (!inSingle && !inDouble && /\s/.test(ch)) {
            if (active) {
                out.push(buf);
                buf = "";
                active = false;
            }
            continue;
        }
        buf += ch;
        active = true;
    }
    if (active) out.push(buf);
    return { positional: out, raw };
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const substituteArgs = (body: string, raw: string): string => {
    const parsed = parseArgs(raw);
    let out = body.replace(/\$ARGUMENTS/g, parsed.raw);
    out = out.replace(/\$(\d+)/g, (_match, digits: string) => {
        const i = Number.parseInt(digits, 10);
        const v = parsed.positional[i];
        return v === undefined ? "" : shellQuote(v);
    });
    return out;
};
