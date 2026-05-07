#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./components/app.tsx";
import { ConfigValidationError, loadConfig } from "./config/index.ts";

const main = async (): Promise<void> => {
    try {
        const config = await loadConfig();
        // App owns Ctrl+C handling: clear input → abort stream → no-op.
        const { waitUntilExit } = render(<App config={config} />, { exitOnCtrlC: false });
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
