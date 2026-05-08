#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./components/app.tsx";
import { ConfigValidationError, loadConfig } from "./config/index.ts";

interface CliFlags {
    readonly resume: boolean;
    readonly resumeSessionId: string | null;
}

const parseFlags = (argv: readonly string[]): CliFlags => {
    let resume = false;
    let resumeSessionId: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--resume") {
            resume = true;
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                resumeSessionId = next;
                i += 1;
            }
        }
    }
    return { resume, resumeSessionId };
};

const main = async (): Promise<void> => {
    try {
        const config = await loadConfig();
        const flags = parseFlags(process.argv.slice(2));
        // App owns Ctrl+C handling: clear input → abort stream → no-op.
        const { waitUntilExit } = render(
            <App
                config={config}
                resumeOnStart={flags.resume}
                resumeSessionId={flags.resumeSessionId}
            />,
            { exitOnCtrlC: false },
        );
        await waitUntilExit();
    } catch (error) {
        if (error instanceof ConfigValidationError) {
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
        }
        throw error;
    }
};

await main();
// Ink's useApp().exit() unmounts the renderer but stdin's raw-mode handle
// can keep the event loop alive — force release back to the parent shell.
process.exit(0);
