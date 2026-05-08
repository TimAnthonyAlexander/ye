export type {
  HookEntry,
  HookEventName,
  HookEventPayload,
  HookResult,
  HooksConfig,
  MatcherGroup,
} from "./types.ts";
export { blockExitCode } from "./types.ts";
export { matchGroups } from "./matcher.ts";
export { runHooks } from "./runner.ts";

import type { HooksConfig, HookEventPayload } from "./types.ts";
import { matchGroups } from "./matcher.ts";
import { runHooks } from "./runner.ts";

export const runEventHooks = async (
  config: HooksConfig | undefined,
  eventName: HookEventPayload["event"],
  extra: Omit<HookEventPayload, "event">,
  signal: AbortSignal,
): Promise<{ blocked: boolean; reason?: string; context?: string }> => {
  if (!config) return { blocked: false };

  const rawGroups = config[eventName as keyof HooksConfig] as
    | readonly import("./types.ts").MatcherGroup[]
    | undefined;

  const groups = matchGroups(rawGroups, extra.tool_name);

  const payload: HookEventPayload = {
    event: eventName,
    ...extra.tool_name ? { tool_name: extra.tool_name } : {},
    ...extra.tool_args !== undefined ? { tool_args: extra.tool_args } : {},
    ...extra.file_paths ? { file_paths: extra.file_paths } : {},
    ...extra.prompt ? { prompt: extra.prompt } : {},
    project_dir: extra.project_dir,
  };

  let contextParts: string[] = [];

  for (const group of groups) {
    const result = await runHooks(group.hooks, payload, signal);
    if (result && result.action === "block") {
      return { blocked: true, reason: result.stderr || "hook blocked" };
    }
    if (result && result.stdout.length > 0) {
      contextParts.push(result.stdout);
    }
  }

  return {
    blocked: false,
    ...(contextParts.length > 0 ? { context: contextParts.join("\n") } : {}),
  };
};
