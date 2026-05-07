// Compiled-binary build with a stub for react-devtools-core. Ink's reconciler
// has a runtime gate (`if (process.env['DEV'] === 'true')`) that prevents the
// devtools chain from running, but `bun build --compile` bundles devtools.js
// regardless because it's reached via a static-string dynamic import. devtools.js
// then has a top-level static `import devtools from 'react-devtools-core'` that
// fails at bundle time (or runtime, depending on flags). We resolve the import
// to a no-op stub so the chain has nothing to break against.

import type { BunPlugin } from "bun";

const target = process.argv[2];
if (target !== "bun-darwin-arm64" && target !== "bun-darwin-x64") {
    console.error(`scripts/build.ts: unsupported target ${target}`);
    process.exit(1);
}

const stubReactDevtools: BunPlugin = {
    name: "stub-react-devtools-core",
    setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: "react-devtools-core",
            namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            // Ink only ever calls `devtools.connectToDevTools()` from a gated
            // branch we've made dead via --define. The stub just needs to
            // import-resolve cleanly.
            contents:
                "export const connectToDevTools = () => {};\n" +
                "export default { connectToDevTools };\n",
            loader: "js",
        }));
    },
};

const result = await Bun.build({
    entrypoints: ["src/cli.tsx"],
    target: "bun",
    define: {
        "process.env.DEV": '"false"',
    },
    plugins: [stubReactDevtools],
    compile: {
        target,
        outfile: "dist/ye",
    },
});

if (!result.success) {
    for (const m of result.logs) console.error(m);
    process.exit(1);
}
