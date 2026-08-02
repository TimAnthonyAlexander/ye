import { extname } from "node:path";

export interface LanguageMapping {
    // Sent to the server in textDocument/didOpen.
    readonly languageId: string;
    // Config keys to try, in order, under `lsp.servers`. A TypeScript server
    // handles JavaScript too, so a user who configures only "typescript" gets
    // .js/.jsx as well.
    readonly configKeys: readonly string[];
}

const MAPPINGS: Readonly<Record<string, LanguageMapping>> = {
    ".ts": { languageId: "typescript", configKeys: ["typescript"] },
    ".tsx": { languageId: "typescriptreact", configKeys: ["typescriptreact", "typescript"] },
    ".mts": { languageId: "typescript", configKeys: ["typescript"] },
    ".cts": { languageId: "typescript", configKeys: ["typescript"] },
    ".js": { languageId: "javascript", configKeys: ["javascript", "typescript"] },
    ".mjs": { languageId: "javascript", configKeys: ["javascript", "typescript"] },
    ".cjs": { languageId: "javascript", configKeys: ["javascript", "typescript"] },
    ".jsx": {
        languageId: "javascriptreact",
        configKeys: ["javascriptreact", "javascript", "typescript"],
    },
    ".py": { languageId: "python", configKeys: ["python"] },
    ".pyi": { languageId: "python", configKeys: ["python"] },
    ".go": { languageId: "go", configKeys: ["go"] },
    ".rs": { languageId: "rust", configKeys: ["rust"] },
};

export const languageForPath = (path: string): LanguageMapping | undefined =>
    MAPPINGS[extname(path).toLowerCase()];

export const extensionOf = (path: string): string => extname(path).toLowerCase();
