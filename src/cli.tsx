#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./components/app.tsx";
import { ConfigValidationError, loadConfig } from "./config/index.ts";

const main = async (): Promise<void> => {
  try {
    const config = await loadConfig();
    const { waitUntilExit } = render(<App config={config} />);
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
