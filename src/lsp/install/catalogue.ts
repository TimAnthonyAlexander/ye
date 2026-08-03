import { join } from "node:path";
import { LSP_BIN_DIR, LSP_DIR, LSP_NODE_BIN_DIR, LSP_NODE_DIR } from "../../storage/paths.ts";

// A server Ye installs under ~/.ye/lsp is fully removable: `rm -rf ~/.ye/lsp`
// undoes it. A toolchain install mutates something Ye does not own (a rustup
// toolchain), so it survives that and must be labelled wherever it surfaces.
export type InstallScope = "ye" | "toolchain";

export type InstallPlan =
    | { readonly kind: "node"; readonly packages: readonly string[] }
    | { readonly kind: "go"; readonly module: string }
    | { readonly kind: "rustup"; readonly component: string };

export interface Prerequisite {
    // Any one of these on PATH satisfies the prerequisite, in preference order.
    readonly anyOf: readonly string[];
    readonly missing: string;
}

export interface ServerEntry {
    readonly language: string;
    readonly displayName: string;
    readonly binary: string;
    readonly args: readonly string[];
    readonly markers: readonly string[];
    readonly install: InstallPlan;
    readonly scope: InstallScope;
    readonly prerequisite: Prerequisite;
    // Trivial post-install probe. Absent means the binary takes no version flag
    // and can only be checked for existence.
    readonly probeArgs?: readonly string[];
    readonly uninstall: string;
    // Other servers for the same language that detection should accept if
    // already present. Ye installs `binary`; it never installs these.
    readonly alternates?: readonly { readonly binary: string; readonly args: readonly string[] }[];
}

export interface InstallRoots {
    readonly lspDir: string;
    readonly binDir: string;
    readonly nodeDir: string;
    readonly nodeBinDir: string;
}

export interface InstallCommand {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    // Set only when the command's effect depends on where it runs.
    readonly cwd?: string;
}

export type Which = (binary: string) => string | null;

export const defaultRoots = (): InstallRoots => ({
    lspDir: LSP_DIR,
    binDir: LSP_BIN_DIR,
    nodeDir: LSP_NODE_DIR,
    nodeBinDir: LSP_NODE_BIN_DIR,
});

export const rootsAt = (lspDir: string): InstallRoots => ({
    lspDir,
    binDir: join(lspDir, "bin"),
    nodeDir: join(lspDir, "node"),
    nodeBinDir: join(lspDir, "node", "node_modules", ".bin"),
});

// Bun.which resolves against the PATH the process launched with unless one is
// handed to it, and a hook or the user's own env can have changed it since.
export const defaultWhich: Which = (binary) => Bun.which(binary, { PATH: process.env.PATH ?? "" });

const NODE_PREREQUISITE: Prerequisite = {
    anyOf: ["bun", "npm"],
    missing:
        "No node package manager found. Install Bun (https://bun.sh) or Node.js (which ships npm) first, then try again.",
};

export const CATALOGUE: readonly ServerEntry[] = [
    {
        language: "typescript",
        displayName: "TypeScript / JavaScript (typescript-language-server)",
        binary: "typescript-language-server",
        args: ["--stdio"],
        markers: ["tsconfig.json", "package.json"],
        install: { kind: "node", packages: ["typescript-language-server", "typescript"] },
        scope: "ye",
        prerequisite: NODE_PREREQUISITE,
        probeArgs: ["--version"],
        uninstall:
            "Removes typescript-language-server and typescript from Ye's private package root under ~/.ye/lsp/node. Nothing outside ~/.ye is touched.",
    },
    {
        language: "python",
        displayName: "Python (pyright)",
        binary: "pyright-langserver",
        args: ["--stdio"],
        markers: ["pyproject.toml", "requirements.txt"],
        install: { kind: "node", packages: ["pyright"] },
        scope: "ye",
        prerequisite: NODE_PREREQUISITE,
        probeArgs: ["--version"],
        uninstall:
            "Removes pyright from Ye's private package root under ~/.ye/lsp/node. Nothing outside ~/.ye is touched.",
        alternates: [{ binary: "pylsp", args: [] }],
    },
    {
        language: "go",
        displayName: "Go (gopls)",
        binary: "gopls",
        args: [],
        markers: ["go.mod"],
        install: { kind: "go", module: "golang.org/x/tools/gopls@latest" },
        scope: "ye",
        prerequisite: {
            anyOf: ["go"],
            missing:
                "`go` is not on your PATH. Install Go (https://go.dev/dl) first — Ye does not install toolchains.",
        },
        probeArgs: ["version"],
        uninstall: "Deletes the gopls binary from ~/.ye/lsp/bin. Nothing outside ~/.ye is touched.",
    },
    {
        language: "rust",
        displayName: "Rust (rust-analyzer)",
        binary: "rust-analyzer",
        args: [],
        markers: ["Cargo.toml"],
        install: { kind: "rustup", component: "rust-analyzer" },
        scope: "toolchain",
        prerequisite: {
            anyOf: ["rustup"],
            missing:
                "`rustup` is not on your PATH. Install Rust via https://rustup.rs first — Ye does not install toolchains.",
        },
        probeArgs: ["--version"],
        uninstall:
            "Ye will not remove this. rust-analyzer is a component of your rustup toolchain, not a file under ~/.ye — run `rustup component remove rust-analyzer` yourself if you want it gone.",
    },
];

export const entryFor = (language: string): ServerEntry | undefined =>
    CATALOGUE.find((entry) => entry.language === language);

export type PrerequisiteResult =
    | { readonly ok: true; readonly tool: string }
    | { readonly ok: false; readonly message: string };

export const checkPrerequisite = (
    entry: ServerEntry,
    which: Which = defaultWhich,
): PrerequisiteResult => {
    const found = entry.prerequisite.anyOf.find((binary) => which(binary) !== null);
    return found === undefined
        ? { ok: false, message: entry.prerequisite.missing }
        : { ok: true, tool: found };
};

// Falls back to the preferred tool when none is installed so the command can
// still be shown; installServer refuses on the prerequisite check before it runs.
const nodeTool = (which: Which): string =>
    NODE_PREREQUISITE.anyOf.find((binary) => which(binary) !== null) ?? "bun";

const nodeInstall = (
    tool: string,
    packages: readonly string[],
    roots: InstallRoots,
): InstallCommand =>
    tool === "bun"
        ? { argv: ["bun", "add", ...packages], env: {}, cwd: roots.nodeDir }
        : {
              argv: ["npm", "install", "--prefix", roots.nodeDir, ...packages],
              env: {},
              cwd: roots.nodeDir,
          };

const nodeUninstall = (
    tool: string,
    packages: readonly string[],
    roots: InstallRoots,
): InstallCommand =>
    tool === "bun"
        ? { argv: ["bun", "remove", ...packages], env: {}, cwd: roots.nodeDir }
        : {
              argv: ["npm", "uninstall", "--prefix", roots.nodeDir, ...packages],
              env: {},
              cwd: roots.nodeDir,
          };

export const buildInstallCommand = (
    entry: ServerEntry,
    roots: InstallRoots,
    which: Which = defaultWhich,
): InstallCommand => {
    const plan = entry.install;
    switch (plan.kind) {
        case "node":
            return nodeInstall(nodeTool(which), plan.packages, roots);
        case "go":
            // GOBIN redirects the produced binary into Ye's own bin dir; without
            // it `go install` writes to the user's GOPATH/bin, which Ye neither
            // owns nor can cleanly undo.
            return {
                argv: ["go", "install", plan.module],
                env: { GOBIN: roots.binDir },
            };
        case "rustup":
            return { argv: ["rustup", "component", "add", plan.component], env: {} };
    }
};

export const buildUninstallCommand = (
    entry: ServerEntry,
    roots: InstallRoots,
    which: Which = defaultWhich,
): InstallCommand | undefined => {
    const plan = entry.install;
    switch (plan.kind) {
        case "node":
            return nodeUninstall(nodeTool(which), plan.packages, roots);
        case "go":
            return undefined;
        case "rustup":
            return { argv: ["rustup", "component", "remove", plan.component], env: {} };
    }
};

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const quote = (value: string): string =>
    SAFE_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export const renderCommand = (command: InstallCommand): string => {
    const assignments = Object.entries(command.env).map(([key, value]) => `${key}=${quote(value)}`);
    const body = [...assignments, ...command.argv.map(quote)].join(" ");
    return command.cwd === undefined ? body : `cd ${quote(command.cwd)} && ${body}`;
};

export interface CommandOptions {
    readonly roots?: InstallRoots;
    readonly which?: Which;
}

// The single source for what the UI shows before asking and what the installer
// spawns. Two renderings would drift, and the user would consent to a command
// that is not the one that runs.
export const installCommandFor = (
    language: string,
    opts: CommandOptions = {},
): string | undefined => {
    const entry = entryFor(language);
    if (entry === undefined) return undefined;
    return renderCommand(
        buildInstallCommand(entry, opts.roots ?? defaultRoots(), opts.which ?? defaultWhich),
    );
};

export const uninstallCommandFor = (
    language: string,
    opts: CommandOptions = {},
): string | undefined => {
    const entry = entryFor(language);
    if (entry === undefined) return undefined;
    const command = buildUninstallCommand(
        entry,
        opts.roots ?? defaultRoots(),
        opts.which ?? defaultWhich,
    );
    return command === undefined ? undefined : renderCommand(command);
};
