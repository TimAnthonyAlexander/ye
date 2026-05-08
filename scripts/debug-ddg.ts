#!/usr/bin/env bun
// Debug helper for the WebSearch tool. Exercises both providers (brave + ddg)
// and the chain in src/tools/webSearch/index.ts. Use to diagnose anti-bot
// blocks or markup drift.
//
// Usage: bun run scripts/debug-ddg.ts [query]

import { runBraveSearch } from "../src/tools/webSearch/brave.ts";
import { runDuckDuckGoSearch } from "../src/tools/webSearch/duckduckgo.ts";

const query = process.argv.slice(2).join(" ") || "anthropic claude code";
const ac = new AbortController();
const args = {
    query,
    maxBytes: 10 * 1024 * 1024,
    limit: 10,
    signal: ac.signal,
} as const;

console.log(`query: ${query}\n`);

console.log("=== BRAVE ===");
const brave = await runBraveSearch(args);
if (brave.ok) {
    console.log(`ok · ${brave.results.length} results`);
    for (const r of brave.results.slice(0, 5)) console.log(`  - ${r.title} → ${r.url}`);
} else {
    console.log(`fail · ${brave.error}`);
}

console.log("\n=== DUCKDUCKGO ===");
const ddg = await runDuckDuckGoSearch(args);
if (ddg.ok) {
    console.log(`ok · ${ddg.results.length} results`);
    for (const r of ddg.results.slice(0, 5)) console.log(`  - ${r.title} → ${r.url}`);
} else {
    console.log(`fail · ${ddg.error}`);
}
