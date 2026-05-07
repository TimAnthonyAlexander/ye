import { Text } from "ink";
import { memo } from "react";

type Run = { readonly text: string; readonly bold: boolean; readonly code: boolean };

// Splits assistant text into bold (`**...**`) and inline-code (`` `...` ``) runs.
// During streaming an unclosed `**` keeps `bold` on through end-of-buffer; the
// next chunk re-parses cleanly when the closing marker arrives.
const parseInline = (s: string): readonly Run[] => {
    const out: Run[] = [];
    let buf = "";
    let bold = false;
    let i = 0;
    const flush = () => {
        if (buf.length > 0) {
            out.push({ text: buf, bold, code: false });
            buf = "";
        }
    };
    while (i < s.length) {
        if (s[i] === "`") {
            const end = s.indexOf("`", i + 1);
            if (end > i) {
                flush();
                out.push({ text: s.slice(i + 1, end), bold, code: true });
                i = end + 1;
                continue;
            }
        }
        if (s[i] === "*" && s[i + 1] === "*") {
            flush();
            bold = !bold;
            i += 2;
            continue;
        }
        buf += s[i];
        i++;
    }
    flush();
    return out;
};

interface InlineMarkdownProps {
    readonly content: string;
}

export const InlineMarkdown = memo(({ content }: InlineMarkdownProps) => {
    const runs = parseInline(content);
    return (
        <>
            {runs.map((run, idx) => (
                <Text key={idx} bold={run.bold} color={run.code ? "cyan" : undefined}>
                    {run.text}
                </Text>
            ))}
        </>
    );
});
InlineMarkdown.displayName = "InlineMarkdown";
