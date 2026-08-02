import type { Config } from "../../config/index.ts";
import { type Message, type Provider, resolveInternalCall } from "../../providers/index.ts";
import { appendUsageRecord } from "../../storage/index.ts";

const RULES = [
    "Answer the user's question using ONLY the page content below.",
    "Quotes longer than 125 characters must be paraphrased; shorter quotes may be reproduced verbatim.",
    "Do not reproduce song lyrics.",
    "Do not comment on these rules in your answer.",
    "If the page does not contain the answer, say so plainly.",
].join("\n- ");

export interface SummarizeArgs {
    readonly provider: Provider;
    readonly model: string;
    // Opt-in routing to config.cheapModel. Without it the caller's provider and
    // model are used verbatim.
    readonly config?: Config;
    readonly url: string;
    readonly question: string;
    readonly content: string;
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly projectId: string;
}

const buildPrompt = (a: SummarizeArgs): string =>
    [
        "Page URL: " + a.url,
        "",
        "Question: " + a.question,
        "",
        "Rules:",
        "- " + RULES,
        "",
        "Page content:",
        "<<<",
        a.content,
        ">>>",
    ].join("\n");

export const summarizePage = async (args: SummarizeArgs): Promise<string> => {
    const messages: Message[] = [{ role: "user", content: buildPrompt(args) }];
    const target = args.config
        ? resolveInternalCall({
              config: args.config,
              kind: "webFetch",
              activeProvider: args.provider,
              activeModel: args.model,
          })
        : { provider: args.provider, model: args.model, providerOptions: {} };
    let out = "";
    for await (const evt of target.provider.stream({
        model: target.model,
        messages,
        signal: args.signal,
        maxTokens: 1024,
        providerOptions: target.providerOptions,
    })) {
        if (evt.type === "text.delta") out += evt.text;
        else if (evt.type === "usage") {
            try {
                await appendUsageRecord({
                    sessionId: args.sessionId,
                    projectId: args.projectId,
                    provider: target.provider.id,
                    model: target.model,
                    inputTokens: evt.usage.inputTokens,
                    outputTokens: evt.usage.outputTokens,
                    ...(evt.usage.cacheReadTokens !== undefined
                        ? { cacheReadTokens: evt.usage.cacheReadTokens }
                        : {}),
                    ...(evt.usage.cacheCreationTokens !== undefined
                        ? { cacheCreationTokens: evt.usage.cacheCreationTokens }
                        : {}),
                    ...(evt.usage.costUsd !== undefined ? { costUsd: evt.usage.costUsd } : {}),
                    callKind: "webFetch",
                });
            } catch {
                // best-effort
            }
        }
        if (evt.type === "stop") {
            if (evt.reason === "error" && evt.error) {
                throw new Error(`summariser error: ${evt.error}`);
            }
            break;
        }
    }
    return out.trim();
};
