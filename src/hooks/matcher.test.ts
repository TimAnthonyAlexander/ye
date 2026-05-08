import { describe, expect, test } from "bun:test";
import { matchGroups } from "./matcher.ts";
import type { MatcherGroup } from "./types.ts";

const mkGroup = (matcher: string | undefined): MatcherGroup => ({
  hooks: [{ type: "command", command: "true" }],
  ...(matcher !== undefined ? { matcher } : {}),
});

describe("matchGroups", () => {
  test("returns empty for undefined groups", () => {
    expect(matchGroups(undefined, "Bash")).toEqual([]);
  });

  test("returns empty for empty array", () => {
    expect(matchGroups([], "Bash")).toEqual([]);
  });

  test("no matcher means match all", () => {
    const groups = [mkGroup(undefined)];
    expect(matchGroups(groups, "Bash")).toHaveLength(1);
    expect(matchGroups(groups, "Edit")).toHaveLength(1);
    expect(matchGroups(groups, undefined)).toHaveLength(1);
  });

  test("exact matcher", () => {
    const groups = [mkGroup("Bash")];
    expect(matchGroups(groups, "Bash")).toHaveLength(1);
    expect(matchGroups(groups, "Edit")).toEqual([]);
  });

  test("regex matcher with pipe", () => {
    const groups = [mkGroup("Edit|Write")];
    expect(matchGroups(groups, "Edit")).toHaveLength(1);
    expect(matchGroups(groups, "Write")).toHaveLength(1);
    expect(matchGroups(groups, "Read")).toEqual([]);
  });

  test("regex with wildcard", () => {
    const groups = [mkGroup("Notebook.*")];
    expect(matchGroups(groups, "NotebookEdit")).toHaveLength(1);
    expect(matchGroups(groups, "Notebook")).toHaveLength(1);
    expect(matchGroups(groups, "Edit")).toEqual([]);
  });

  test("multiple groups, first match applies", () => {
    const groups = [mkGroup("Bash"), mkGroup("Edit"), mkGroup(undefined)];
    expect(matchGroups(groups, "Bash")).toHaveLength(2); // Bash + unmatcher
    expect(matchGroups(groups, "Edit")).toHaveLength(2); // Edit + unmatcher
    expect(matchGroups(groups, "Read")).toHaveLength(1); // only unmatcher
  });

  test("invalid regex returns no match", () => {
    const groups = [mkGroup("[invalid")];
    expect(matchGroups(groups, "Bash")).toEqual([]);
  });
});
