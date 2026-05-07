import TurndownService from "turndown";

const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
});

service.remove(["script", "style", "noscript", "iframe", "svg"]);

export const htmlToMarkdown = (html: string): string => service.turndown(html);
