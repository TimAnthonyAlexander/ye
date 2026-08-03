import { getMonitorManager, type MonitorTask } from "../monitors/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const USAGE = "/monitors · /monitors kill <id>";

const WHAT_IT_IS =
    "A monitor watches something in the background — a shell condition becoming true, or a clock time — and reports back when it fires, so nothing has to sit and wait for it.";

export type MonitorsAction =
    | { readonly kind: "list" }
    | { readonly kind: "kill"; readonly id: string }
    | { readonly kind: "error"; readonly message: string };

export const parseMonitorsArgs = (args: string): MonitorsAction => {
    const words = args
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0);
    const verb = words[0];
    if (verb === undefined || verb === "list") {
        return words.length > 1
            ? {
                  kind: "error",
                  message: `\`/monitors ${verb}\` takes no arguments. Usage: ${USAGE}`,
              }
            : { kind: "list" };
    }
    if (verb !== "kill") {
        return { kind: "error", message: `Unknown subcommand \`${verb}\`. Usage: ${USAGE}` };
    }
    if (words.length > 2) {
        return {
            kind: "error",
            message: `\`/monitors kill\` takes one monitor id. Usage: ${USAGE}`,
        };
    }
    const id = words[1];
    if (id === undefined) {
        return { kind: "error", message: `\`/monitors kill\` needs a monitor id. Usage: ${USAGE}` };
    }
    return { kind: "kill", id };
};

const duration = (ms: number): string => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// "gave_up" is the one status a reader can misread as an answer about the thing
// being watched. It is only a statement about what this monitor observed.
const outcomeNote = (task: MonitorTask): readonly string[] => {
    switch (task.status) {
        case "running":
            return [];
        case "condition_met":
            return ["the condition became true"];
        case "time_reached":
            return ["the scheduled time arrived"];
        case "gave_up":
            return [
                "the condition was never observed true before the deadline — that is not evidence",
                "it did not happen, only that this monitor never saw it. Check directly.",
            ];
        case "broken":
            return [
                "the condition command kept failing, so the monitor could never tell whether the",
                "condition held. Nothing is known about the thing being watched.",
            ];
        case "killed":
            return ["stopped before it reached any outcome"];
    }
};

const WIDTH = 19;
const DETAIL = " ".repeat(WIDTH);

export const monitorLines = (tasks: readonly MonitorTask[], now: number): readonly string[] => {
    if (tasks.length === 0) {
        return ["Monitors", "  none in this session", `  ${WHAT_IT_IS}`, `  ${USAGE}`];
    }
    const lines: string[] = ["Monitors"];
    for (const task of tasks) {
        const elapsed = duration((task.finishedAt ?? now) - task.startedAt);
        const polls = `${task.polls} poll${task.polls === 1 ? "" : "s"}`;
        const clock = task.status === "running" ? `running for ${elapsed}` : `ran for ${elapsed}`;
        lines.push(`  [${task.status}]`.padEnd(WIDTH) + `${task.id.padEnd(12)}${task.reason}`);
        lines.push(`${DETAIL}${clock} · ${polls}`);
        for (const note of outcomeNote(task)) lines.push(`${DETAIL}${note}`);
        if (task.error !== undefined) lines.push(`${DETAIL}error: ${task.error}`);
    }
    lines.push(`  ${USAGE}`);
    return lines;
};

export type KillPlan =
    | { readonly kind: "kill"; readonly message: string }
    | { readonly kind: "noop"; readonly message: string }
    | { readonly kind: "error"; readonly message: string };

const idList = (tasks: readonly MonitorTask[]): string =>
    tasks.length === 0
        ? "There are no monitors in this session."
        : `Ids in this session: ${tasks.map((task) => `${task.id} (${task.status})`).join(", ")}.`;

export const planKill = (tasks: readonly MonitorTask[], id: string): KillPlan => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task === undefined) {
        return { kind: "error", message: `No monitor with id \`${id}\`. ${idList(tasks)}` };
    }
    if (task.status !== "running") {
        return {
            kind: "noop",
            message: `${task.id} (${task.reason}) already finished — ${task.status}. Nothing to kill; /monitors shows its outcome.`,
        };
    }
    return {
        kind: "kill",
        message: `Killed ${task.id} (${task.reason}). It will not report back.`,
    };
};

const MAX_REASONS = 2;
const REASON_CAP = 40;

const clip = (text: string): string =>
    text.length <= REASON_CAP ? text : `${text.slice(0, REASON_CAP - 1)}…`;

export const runningMonitorSummary = (tasks: readonly MonitorTask[]): string => {
    const running = tasks.filter((task) => task.status === "running");
    if (running.length === 0) return "none";
    const shown = running.slice(0, MAX_REASONS).map((task) => clip(task.reason));
    const rest = running.length - shown.length;
    const reasons = rest > 0 ? `${shown.join("; ")} (+${rest} more)` : shown.join("; ");
    return `${running.length} running — waiting for ${reasons}`;
};

export const MonitorsCommand: SlashCommand = {
    name: "monitors",
    description: "List background monitors and their outcomes, or stop one.",
    usage: "/monitors [kill <id>]",
    execute: (args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const action = parseMonitorsArgs(args);
        if (action.kind === "error") return { kind: "error", message: action.message };

        const manager = getMonitorManager(ctx.sessionId);
        if (action.kind === "list") {
            ctx.addSystemMessage(monitorLines(manager.list(), Date.now()).join("\n"));
            return { kind: "ok" };
        }

        const plan = planKill(manager.list(), action.id);
        if (plan.kind === "error") return { kind: "error", message: plan.message };
        if (plan.kind === "kill") manager.kill(action.id);
        ctx.addSystemMessage(plan.message);
        return { kind: "ok" };
    },
};
