import { describe, expect, it } from "bun:test";
import type { InstallResult, UninstallResult } from "../lsp/install/index.ts";
import {
    buildLspCommand,
    parseLspArgs,
    statusLines,
    type LanguageStatus,
    type LspRuntime,
} from "./lsp.ts";
import type { SlashCommandContext } from "./types.ts";

// The Ink surfaces — the /lsp confirmation picker and the session-start offer
// banner — are manual-only. Everything below is the pure part underneath them.

const row = (over: Partial<LanguageStatus> = {}): LanguageStatus => ({
    language: "python",
    displayName: "Python (pyright)",
    matched: true,
    serverPath: null,
    serverSource: null,
    declined: false,
    prerequisiteMissing: null,
    installCommand: "bun add pyright",
    ...over,
});

const okInstall: InstallResult = {
    ok: true,
    language: "python",
    binary: "pyright-langserver",
    path: "/tmp/pyright-langserver",
    scope: "ye",
    output: "done",
};

const failedUninstall: UninstallResult = {
    ok: false,
    language: "python",
    scope: "ye",
    output: "boom",
    error: "uninstall exited 1",
};

interface Recorded {
    readonly messages: string[];
    readonly installs: string[];
    readonly uninstalls: string[];
    readonly written: string[];
}

const harness = (
    answers: readonly (string | null)[],
    over: Partial<LspRuntime> = {},
): {
    readonly ctx: SlashCommandContext;
    readonly rt: LspRuntime;
    readonly log: Recorded;
} => {
    const log: Recorded = { messages: [], installs: [], uninstalls: [], written: [] };
    const queue = [...answers];
    const ctx = {
        projectRoot: "/project",
        config: {},
        addSystemMessage: (text: string) => {
            log.messages.push(text);
        },
        streamOutput: () => ({
            write: (line: string) => {
                log.written.push(line);
            },
            close: () => {},
        }),
        pick: async () => (queue.length > 0 ? (queue.shift() ?? null) : null),
    } as unknown as SlashCommandContext;

    const rt: LspRuntime = {
        install: async (language, opts) => {
            log.installs.push(language);
            opts.onProgress?.("$ bun add pyright");
            return okInstall;
        },
        uninstall: async (language) => {
            log.uninstalls.push(language);
            return { ok: true, language, scope: "ye", output: "removed" };
        },
        invalidate: () => {},
        collect: () => [row()],
        locate: () => null,
        prerequisite: () => ({ ok: true, tool: "bun" }),
        ...over,
    };
    return { ctx, rt, log };
};

describe("parseLspArgs", () => {
    it("treats no arguments as status", () => {
        expect(parseLspArgs("")).toEqual({ kind: "status" });
        expect(parseLspArgs("   ")).toEqual({ kind: "status" });
        expect(parseLspArgs("status")).toEqual({ kind: "status" });
    });

    it("parses install and uninstall", () => {
        expect(parseLspArgs("install typescript")).toEqual({
            kind: "install",
            language: "typescript",
        });
        expect(parseLspArgs("uninstall go")).toEqual({ kind: "uninstall", language: "go" });
    });

    it("lowercases the language", () => {
        expect(parseLspArgs("install TypeScript")).toEqual({
            kind: "install",
            language: "typescript",
        });
    });

    it("rejects an unknown subcommand", () => {
        const action = parseLspArgs("frobnicate typescript");
        expect(action.kind).toBe("error");
        expect(action.kind === "error" && action.message).toContain("frobnicate");
    });

    it("lists the valid languages when the language is unknown", () => {
        const action = parseLspArgs("install cobol");
        expect(action.kind).toBe("error");
        const message = action.kind === "error" ? action.message : "";
        expect(message).toContain("cobol");
        expect(message).toContain("typescript");
        expect(message).toContain("rust");
    });

    it("lists the valid languages when the language is missing", () => {
        const action = parseLspArgs("install");
        expect(action.kind).toBe("error");
        const message = action.kind === "error" ? action.message : "";
        expect(message).toContain("needs a language");
        expect(message).toContain("python");
    });

    it("rejects extra arguments", () => {
        expect(parseLspArgs("install python extra").kind).toBe("error");
        expect(parseLspArgs("status now").kind).toBe("error");
    });
});

describe("statusLines", () => {
    it("reports a resolved server and where it came from", () => {
        const text = statusLines([
            row({ serverPath: "/home/u/.ye/lsp/node/.bin/pyright-langserver", serverSource: "ye" }),
        ]).join("\n");
        expect(text).toContain("[ready]");
        expect(text).toContain("project matches");
        expect(text).toContain("/home/u/.ye/lsp/node/.bin/pyright-langserver (installed by Ye)");
        expect(text).not.toContain("install bun add pyright");
    });

    it("labels a PATH server", () => {
        const text = statusLines([
            row({ serverPath: "/usr/bin/pyright-langserver", serverSource: "path" }),
        ]).join("\n");
        expect(text).toContain("(on PATH)");
    });

    it("shows the exact install command for a missing server", () => {
        const text = statusLines([row()]).join("\n");
        expect(text).toContain("[missing]");
        expect(text).toContain("server  not found");
        expect(text).toContain("install bun add pyright");
    });

    it("marks a declined language and how to undo it", () => {
        const text = statusLines([row({ declined: true })]).join("\n");
        expect(text).toContain("[declined]");
        expect(text).toContain("/lsp install python still works");
    });

    it("shows the prerequisite instead of a command that cannot run", () => {
        const text = statusLines([row({ prerequisiteMissing: "`go` is not on your PATH." })]).join(
            "\n",
        );
        expect(text).toContain("[blocked]");
        expect(text).toContain("`go` is not on your PATH.");
        expect(text).not.toContain("install bun add pyright");
    });

    it("says when the project does not match", () => {
        expect(statusLines([row({ matched: false })]).join("\n")).toContain("project no match");
    });
});

describe("/lsp install", () => {
    it("installs once, and only after an affirmative answer", async () => {
        const { ctx, rt, log } = harness(["install"]);
        const result = await buildLspCommand(rt).execute("install python", ctx);
        expect(result).toEqual({ kind: "ok" });
        expect(log.installs).toEqual(["python"]);
    });

    it("installs nothing when the picker is dismissed", async () => {
        const { ctx, rt, log } = harness([null]);
        await buildLspCommand(rt).execute("install python", ctx);
        expect(log.installs).toEqual([]);
        expect(log.messages.join("\n")).toContain("Cancelled");
    });

    it("installs nothing when the answer is cancel", async () => {
        const { ctx, rt, log } = harness(["cancel"]);
        await buildLspCommand(rt).execute("install python", ctx);
        expect(log.installs).toEqual([]);
    });

    it("shows the exact command before asking", async () => {
        const { ctx, rt, log } = harness(["install"]);
        await buildLspCommand(rt).execute("install python", ctx);
        expect(log.messages[0]).toContain("bun add pyright");
    });

    it("does not ask when a server is already resolved", async () => {
        const { ctx, rt, log } = harness(["install"], {
            locate: () => ({ path: "/usr/bin/pyright-langserver", source: "path" }),
        });
        await buildLspCommand(rt).execute("install python", ctx);
        expect(log.installs).toEqual([]);
        expect(log.messages.join("\n")).toContain("already available");
    });

    it("does not ask when the prerequisite is missing", async () => {
        const { ctx, rt, log } = harness(["install"], {
            prerequisite: () => ({ ok: false, message: "no package manager found" }),
        });
        await buildLspCommand(rt).execute("install python", ctx);
        expect(log.installs).toEqual([]);
        expect(log.messages.join("\n")).toContain("no package manager found");
    });

    it("streams installer progress into the chat", async () => {
        const { ctx, rt, log } = harness(["install"]);
        await buildLspCommand(rt).execute("install python", ctx);
        expect(log.written).toEqual(["$ bun add pyright"]);
    });

    it("reports the tail of the output on failure", async () => {
        const { ctx, rt, log } = harness(["install"], {
            install: async () => ({
                ok: false,
                language: "python",
                binary: "pyright-langserver",
                scope: "ye",
                output: "line one\nline two",
                error: "install exited 1",
            }),
        });
        const result = await buildLspCommand(rt).execute("install python", ctx);
        expect(result).toEqual({ kind: "error", message: "install exited 1" });
        expect(log.messages.join("\n")).toContain("line two");
    });
});

describe("/lsp uninstall", () => {
    it("removes a Ye-scoped server after confirmation", async () => {
        const { ctx, rt, log } = harness(["uninstall"]);
        await buildLspCommand(rt).execute("uninstall python", ctx);
        expect(log.uninstalls).toEqual(["python"]);
    });

    it("removes nothing when dismissed", async () => {
        const { ctx, rt, log } = harness([null]);
        await buildLspCommand(rt).execute("uninstall python", ctx);
        expect(log.uninstalls).toEqual([]);
    });

    it("never runs anything for a toolchain-scoped server", async () => {
        const { ctx, rt, log } = harness(["uninstall"]);
        const result = await buildLspCommand(rt).execute("uninstall rust", ctx);
        expect(result).toEqual({ kind: "ok" });
        expect(log.uninstalls).toEqual([]);
        const text = log.messages.join("\n");
        expect(text).toContain("Ye will not uninstall");
        expect(text).toContain("rustup component remove rust-analyzer");
    });

    it("surfaces a failure with the output tail", async () => {
        const { ctx, rt, log } = harness(["uninstall"], {
            uninstall: async () => failedUninstall,
        });
        const result = await buildLspCommand(rt).execute("uninstall python", ctx);
        expect(result).toEqual({ kind: "error", message: "uninstall exited 1" });
        expect(log.messages.join("\n")).toContain("boom");
    });
});

describe("/lsp status", () => {
    it("renders the collected rows", async () => {
        const { ctx, rt, log } = harness([]);
        const result = await buildLspCommand(rt).execute("", ctx);
        expect(result).toEqual({ kind: "ok" });
        expect(log.messages[0]).toContain("Language servers");
    });

    it("rejects an unknown subcommand without touching the installer", async () => {
        const { ctx, rt, log } = harness([]);
        const result = await buildLspCommand(rt).execute("nope", ctx);
        expect(result.kind).toBe("error");
        expect(log.installs).toEqual([]);
    });
});
