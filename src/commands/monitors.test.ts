import { describe, expect, it } from "bun:test";
import type { MonitorTask } from "../monitors/index.ts";
import { monitorLines, parseMonitorsArgs, planKill, runningMonitorSummary } from "./monitors.ts";

const NOW = 1_700_000_000_000;

const task = (over: Partial<MonitorTask> = {}): MonitorTask => ({
    id: "monitor-1",
    reason: "deploy to finish",
    status: "running",
    startedAt: NOW - 125_000,
    polls: 4,
    output: "",
    ...over,
});

describe("parseMonitorsArgs", () => {
    it("treats no arguments as a list", () => {
        expect(parseMonitorsArgs("")).toEqual({ kind: "list" });
        expect(parseMonitorsArgs("   ")).toEqual({ kind: "list" });
        expect(parseMonitorsArgs("list")).toEqual({ kind: "list" });
    });

    it("parses kill with an id", () => {
        expect(parseMonitorsArgs("kill monitor-2")).toEqual({ kind: "kill", id: "monitor-2" });
        expect(parseMonitorsArgs("  kill   monitor-2  ")).toEqual({
            kind: "kill",
            id: "monitor-2",
        });
    });

    it("rejects an unknown subcommand", () => {
        const action = parseMonitorsArgs("frobnicate monitor-1");
        expect(action.kind).toBe("error");
        expect(action.kind === "error" && action.message).toContain("frobnicate");
    });

    it("rejects kill without an id", () => {
        const action = parseMonitorsArgs("kill");
        expect(action.kind).toBe("error");
        expect(action.kind === "error" && action.message).toContain("needs a monitor id");
    });

    it("rejects extra arguments", () => {
        expect(parseMonitorsArgs("kill monitor-1 monitor-2").kind).toBe("error");
        expect(parseMonitorsArgs("list now").kind).toBe("error");
    });
});

describe("monitorLines", () => {
    it("explains what a monitor is when there are none", () => {
        const text = monitorLines([], NOW).join("\n");
        expect(text).toContain("none in this session");
        expect(text).toContain("watches something in the background");
        expect(text).toContain("/monitors kill <id>");
    });

    it("shows a running monitor with its elapsed time and poll count", () => {
        const text = monitorLines([task()], NOW).join("\n");
        expect(text).toContain("[running]");
        expect(text).toContain("monitor-1");
        expect(text).toContain("deploy to finish");
        expect(text).toContain("running for 2m 5s");
        expect(text).toContain("4 polls");
    });

    it("measures a finished monitor to when it finished, not to now", () => {
        const text = monitorLines(
            [
                task({
                    status: "condition_met",
                    startedAt: NOW - 600_000,
                    finishedAt: NOW - 570_000,
                    polls: 1,
                }),
            ],
            NOW,
        ).join("\n");
        expect(text).toContain("[condition_met]");
        expect(text).toContain("ran for 30s");
        expect(text).toContain("· 1 poll");
        expect(text).toContain("the condition became true");
    });

    it("reports a reached time", () => {
        const text = monitorLines(
            [task({ status: "time_reached", finishedAt: NOW, reason: "the 09:00 window" })],
            NOW,
        ).join("\n");
        expect(text).toContain("[time_reached]");
        expect(text).toContain("the scheduled time arrived");
    });

    it("never renders gave_up as the watched thing not happening", () => {
        const text = monitorLines(
            [task({ id: "monitor-2", status: "gave_up", finishedAt: NOW, polls: 120 })],
            NOW,
        ).join("\n");
        expect(text).toContain("[gave_up]");
        expect(text).toContain("never observed true before the deadline");
        expect(text).toContain("not evidence");
        expect(text).toContain("Check directly.");
        expect(text).not.toContain("never happened");
        expect(text).not.toContain("failed");
    });

    it("shows the error for a broken monitor", () => {
        const text = monitorLines(
            [
                task({
                    id: "monitor-3",
                    status: "broken",
                    finishedAt: NOW,
                    error: "gh: command not found",
                }),
            ],
            NOW,
        ).join("\n");
        expect(text).toContain("[broken]");
        expect(text).toContain("error: gh: command not found");
        expect(text).toContain("Nothing is known about the thing being watched.");
    });

    it("reports a killed monitor as having no outcome", () => {
        const text = monitorLines([task({ status: "killed", finishedAt: NOW })], NOW).join("\n");
        expect(text).toContain("[killed]");
        expect(text).toContain("stopped before it reached any outcome");
    });

    it("lists running and finished monitors together", () => {
        const text = monitorLines(
            [
                task(),
                task({ id: "monitor-2", status: "gave_up", finishedAt: NOW }),
                task({ id: "monitor-3", status: "killed", finishedAt: NOW }),
            ],
            NOW,
        ).join("\n");
        expect(text).toContain("monitor-1");
        expect(text).toContain("monitor-2");
        expect(text).toContain("monitor-3");
    });
});

describe("planKill", () => {
    it("kills a running monitor", () => {
        const plan = planKill([task()], "monitor-1");
        expect(plan.kind).toBe("kill");
        expect(plan.message).toContain("Killed monitor-1");
        expect(plan.message).toContain("deploy to finish");
    });

    it("lists the valid ids for an unknown id", () => {
        const plan = planKill(
            [task(), task({ id: "monitor-2", status: "gave_up", finishedAt: NOW })],
            "monitor-9",
        );
        expect(plan.kind).toBe("error");
        expect(plan.message).toContain("monitor-9");
        expect(plan.message).toContain("monitor-1 (running)");
        expect(plan.message).toContain("monitor-2 (gave_up)");
    });

    it("says there are no monitors at all when the list is empty", () => {
        const plan = planKill([], "monitor-1");
        expect(plan.kind).toBe("error");
        expect(plan.message).toContain("no monitors in this session");
    });

    it("does not pretend to kill a monitor that already finished", () => {
        const plan = planKill([task({ status: "condition_met", finishedAt: NOW })], "monitor-1");
        expect(plan.kind).toBe("noop");
        expect(plan.message).toContain("already finished");
        expect(plan.message).toContain("condition_met");
        expect(plan.message).not.toContain("Killed");
    });
});

describe("runningMonitorSummary", () => {
    it("says none when nothing is running", () => {
        expect(runningMonitorSummary([])).toBe("none");
        expect(runningMonitorSummary([task({ status: "gave_up", finishedAt: NOW })])).toBe("none");
    });

    it("names what a single monitor is waiting for", () => {
        expect(runningMonitorSummary([task()])).toBe("1 running — waiting for deploy to finish");
    });

    it("counts the overflow instead of listing every reason", () => {
        const summary = runningMonitorSummary([
            task({ id: "monitor-1", reason: "a" }),
            task({ id: "monitor-2", reason: "b" }),
            task({ id: "monitor-3", reason: "c" }),
            task({ id: "monitor-4", reason: "d" }),
        ]);
        expect(summary).toBe("4 running — waiting for a; b (+2 more)");
    });

    it("clips a long reason", () => {
        const summary = runningMonitorSummary([task({ reason: "x".repeat(80) })]);
        expect(summary.length).toBeLessThan(70);
        expect(summary).toContain("…");
    });

    it("ignores finished monitors in the count", () => {
        const summary = runningMonitorSummary([
            task(),
            task({ id: "monitor-2", status: "broken", finishedAt: NOW }),
        ]);
        expect(summary).toBe("1 running — waiting for deploy to finish");
    });
});
