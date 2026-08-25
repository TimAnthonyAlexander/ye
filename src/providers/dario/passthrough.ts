import type { Message } from "../types.ts";

// Why Ye sends dario two extra system blocks it does not otherwise need.
//
// dario has two request paths. Which one a request takes decides whether the
// model ever sees Ye's tools at all:
//
//   template path (default) — dario REPLACES the request. `system` becomes
//     [billing tag, CC agent identity, CC's own ~25KB system prompt + ours],
//     and `tools` becomes Claude Code's canonical definitions, filtered to the
//     CC-native names we happened to declare. Ye's schemas are discarded. Every
//     tool of ours CC doesn't have (Task, TodoWrite, BashOutput, KillShell,
//     KillAgent, KillMonitor, Diagnostics, SaveMemory, the three LSP tools) is
//     round-robined onto a CC fallback slot and never advertised. The model is
//     then Claude Code: it reads CC's prompt, sees CC's schemas, calls
//     Read(file_path), AskUserQuestion(questions: [...]), EnterPlanMode(), and
//     invents TodoWrite/Task calls out of the prompt text — which is where
//     `todos` arrived as a JSON *string* rather than an array.
//
//   passthrough path — `isGenuineCCClient(body)` in dario's cc-template.ts
//     returns true, and dario forwards `system` and `tools` byte-faithfully,
//     keeping only its own billing tag at system[0], its identity headers, and
//     its cache breakpoints. Ye's real tools and real prompt reach the model.
//
// The discriminator is purely structural: `system` must be an array of two or
// more blocks, block 0's text must contain `x-anthropic-billing-header:`, and
// block 1's text must open with one of Claude Code's system-prompt openers OR
// mention the Claude Agent SDK. That is all these two blocks are for.
//
// Neither block reaches the model unchanged: dario overwrites block 0 with its
// own billing tag, and its `extractSystemText` filters that block out of
// everything else it does.
export const DARIO_BILLING_BLOCK = "x-anthropic-billing-header: cc_entrypoint=sdk-cli;";

// Block 1. Carries the "Claude Agent SDK" marker the detector keys on, and
// earns its place in the prompt by stating the tool contract — Claude models
// reach for Claude Code's tool and parameter names whatever schema they are
// handed (see tools/argAliases.ts), and this is the one request shape where
// that habit used to be correct.
export const DARIO_CLIENT_BLOCK = `Ye drives this session over the Claude Agent SDK wire format: the Messages API with client-supplied tools.

The tools declared in this request are the complete and authoritative set. Call them by the exact names and parameter names declared there, and call nothing else. Claude Code's own tools are not available here and its parameter spellings are not accepted — \`path\` is not \`file_path\`, \`kind\` is not \`subagent_type\`, \`command\` is not \`skill\`, and a tool that is absent from this request does not exist no matter how familiar it feels. An array parameter takes a JSON array, never a string holding one.`;

// dario forwards a genuine CC client's own identity headers instead of its
// template values, `user-agent` included — and Bun's default is `Bun/1.3.1`.
// An empty value is skipped by that forwarder, so dario's captured Claude Code
// user-agent stands, which is what keeps the request looking like CC upstream.
export const DARIO_HEADERS: Readonly<Record<string, string>> = { "user-agent": "" };

export const withPassthroughSystem = (messages: readonly Message[]): readonly Message[] => [
    { role: "system", content: DARIO_BILLING_BLOCK },
    { role: "system", content: DARIO_CLIENT_BLOCK },
    ...messages,
];
