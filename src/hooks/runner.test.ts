import { describe, expect, test } from "bun:test";
import { runHooks } from "./runner.ts";
import type { HookEntry, HookEventPayload } from "./types.ts";

const basicPayload: HookEventPayload = {
  event: "PreToolUse",
  tool_name: "Bash",
  tool_args: { command: "echo hello" },
  project_dir: "/tmp",
};

const signal = new AbortController().signal;

describe("runHooks", () => {
  test("returns null when hooks list is undefined", async () => {
    const result = await runHooks(undefined, basicPayload, signal);
    expect(result).toBeNull();
  });

  test("returns null when hooks list is empty", async () => {
    const result = await runHooks([], basicPayload, signal);
    expect(result).toBeNull();
  });

  test("runs exit-0 hook and captures stdout", async () => {
    const entries: readonly HookEntry[] = [
      { type: "command", command: "echo 'hook ran ok'" },
    ];
    const result = await runHooks(entries, basicPayload, signal);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("continue");
    expect(result!.stdout).toContain("hook ran ok");
  });

  test("blocked by exit-2 hook", async () => {
    const entries: readonly HookEntry[] = [
      { type: "command", command: "echo blocked >&2; exit 2" },
    ];
    const result = await runHooks(entries, basicPayload, signal);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.stderr).toContain("blocked");
  });

  test("non-zero non-blocking error (exit 1) does not block", async () => {
    const entries: readonly HookEntry[] = [
      { type: "command", command: "echo something failed >&2; exit 1" },
    ];
    const result = await runHooks(entries, basicPayload, signal);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("continue");
    expect(result!.stderr).toContain("something failed");
  });

  test("timeout returns continue with timer message", async () => {
    const entries: readonly HookEntry[] = [
      { type: "command", command: "sleep 10", timeout: 1 },
    ];
    const result = await runHooks(entries, basicPayload, signal);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("continue");
    expect(result!.stderr).toContain("timed out");
  });

  test("receives stdin JSON payload as env var", async () => {
    const entries: readonly HookEntry[] = [
      {
        type: "command",
        command: "cat > /dev/null; echo $YE_EVENT && echo $YE_TOOL_NAME && echo $YE_PROJECT_DIR",
      },
    ];
    const result = await runHooks(entries, basicPayload, signal);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("continue");
    expect(result!.stdout).toContain("PreToolUse");
    expect(result!.stdout).toContain("Bash");
    expect(result!.stdout).toContain("/tmp");
  });

  test("file paths env var when provided", async () => {
    const payload: HookEventPayload = {
      event: "PostToolUse",
      tool_name: "Write",
      file_paths: ["/tmp/a.ts", "/tmp/b.ts"],
      project_dir: "/tmp",
    };
    const entries: readonly HookEntry[] = [
      {
        type: "command",
        command: "echo $YE_FILE_PATHS",
      },
    ];
    const result = await runHooks(entries, payload, signal);
    expect(result).not.toBeNull();
    expect(result!.stdout).toContain("/tmp/a.ts");
    expect(result!.stdout).toContain("/tmp/b.ts");
  });

  test("aborted signal exits early with continue", async () => {
    const ctrl = new AbortController();
    const entries: readonly HookEntry[] = [
      { type: "command", command: "sleep 5", timeout: 60 },
    ];
    const promise = runHooks(entries, basicPayload, ctrl.signal);
    // Give the hook a moment to start, then abort.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.action).toBe("continue");
  });

  test("multiple hooks: first non-blocking runs, second blocks", async () => {
    const entries: readonly HookEntry[] = [
      { type: "command", command: "echo pass1" },
      { type: "command", command: "echo stopped >&2; exit 2" },
      { type: "command", command: "echo never-reached" },
    ];
    const result = await runHooks(entries, basicPayload, signal);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.stderr).toContain("stopped");
  });
});
