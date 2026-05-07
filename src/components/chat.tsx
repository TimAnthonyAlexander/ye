import { Box, Static, Text } from "ink";
import { memo } from "react";
import { AssistantLine, MessageView } from "./message.tsx";
import { Thinking } from "./thinking.tsx";
import { summarizeArgs, ToolCallView, type ToolCallEntry } from "./toolCall.tsx";
import { Welcome } from "./welcome.tsx";

export type ChatItem =
    | {
          readonly kind: "message";
          readonly id: string;
          readonly role: "user" | "assistant";
          readonly content: string;
      }
    | { readonly kind: "system"; readonly id: string; readonly content: string }
    | { readonly kind: "toolCall"; readonly entry: ToolCallEntry }
    | {
          readonly kind: "welcome";
          readonly id: string;
          readonly version: string;
          readonly cwd: string;
          readonly providerId: string;
          readonly model: string;
          readonly username: string | null;
      };

interface ChatProps {
    readonly items: readonly ChatItem[];
    readonly streamingText: string;
    readonly streaming: boolean;
    // Index up to which `items` are eligible for Static (scrollback) commit.
    // Advanced by App when streaming ends; never shrunk except on rotateSession.
    // Holds back commits during a streaming session so consecutive read-only
    // tool calls can fold into a single group as they arrive.
    readonly committedCount: number;
    // Toggled with Ctrl+O; only affects groups in the dynamic (in-flight)
    // section. Static-committed groups freeze in collapsed form.
    readonly groupsExpanded: boolean;
}

// Sequence-based IDs for messages/system items. Module-level is fine because
// these are minted at creation time (in setItems handlers), never during a
// render — the previous bug was a counter that bumped every itemKey() call.
let idSeq = 0;
export const newChatItemId = (): string => `c${++idSeq}`;

const itemKey = (item: ChatItem): string =>
    item.kind === "toolCall" ? `t-${item.entry.id}` : `c-${item.id}`;

// Tools whose runs are bundled into one row when consecutive. Exclusively
// read-only and high-frequency — Edit/Write/Bash/Task are rare enough that
// each call earns its own line.
const BUNDLEABLE: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

type RenderUnit =
    | { readonly kind: "single"; readonly key: string; readonly item: ChatItem }
    | {
          readonly kind: "group";
          readonly key: string;
          readonly name: string;
          readonly entries: readonly ToolCallEntry[];
      };

const groupItems = (items: readonly ChatItem[]): readonly RenderUnit[] => {
    const units: RenderUnit[] = [];
    for (const item of items) {
        const bundleable =
            item.kind === "toolCall" &&
            BUNDLEABLE.has(item.entry.name) &&
            item.entry.status !== "error";

        if (bundleable && item.kind === "toolCall") {
            const last = units[units.length - 1];
            if (last && last.kind === "group" && last.name === item.entry.name) {
                units[units.length - 1] = {
                    kind: "group",
                    key: last.key,
                    name: last.name,
                    entries: [...last.entries, item.entry],
                };
                continue;
            }
            units.push({
                kind: "group",
                key: `g-${item.entry.id}`,
                name: item.entry.name,
                entries: [item.entry],
            });
            continue;
        }
        units.push({ kind: "single", key: itemKey(item), item });
    }
    return units;
};

interface RenderItemProps {
    readonly item: ChatItem;
}

// Memoized: re-renders only when the item reference changes. Tool calls get
// new entry references on status updates (entry: {...prev, status}), which
// is what we want; messages and system items never mutate after creation.
const RenderItem = memo(({ item }: RenderItemProps) => {
    if (item.kind === "message") {
        return <MessageView message={{ role: item.role, content: item.content }} />;
    }
    if (item.kind === "system") {
        return (
            <Box marginBottom={1}>
                <Text dimColor>{item.content}</Text>
            </Box>
        );
    }
    if (item.kind === "welcome") {
        return (
            <Welcome
                version={item.version}
                cwd={item.cwd}
                providerId={item.providerId}
                model={item.model}
                username={item.username}
            />
        );
    }
    return <ToolCallView entry={item.entry} />;
});
RenderItem.displayName = "RenderItem";

const COLLAPSED_NOUN: Record<string, string> = {
    Read: "files",
    Glob: "patterns",
    Grep: "patterns",
};

interface GroupViewProps {
    readonly name: string;
    readonly entries: readonly ToolCallEntry[];
    readonly expanded: boolean;
    readonly interactive: boolean;
}

const GroupView = memo(({ name, entries, expanded, interactive }: GroupViewProps) => {
    if (entries.length === 1) {
        // A "group" of one renders identically to a single tool call — no
        // count, no hint, no special framing.
        return <ToolCallView entry={entries[0]!} />;
    }
    if (expanded) {
        return (
            <Box flexDirection="column">
                {entries.map((entry) => (
                    <ToolCallView key={entry.id} entry={entry} />
                ))}
                {interactive && (
                    <Box marginBottom={1}>
                        <Text dimColor>↳ ctrl+o to collapse</Text>
                    </Box>
                )}
            </Box>
        );
    }
    const anyRunning = entries.some((e) => e.status === "running");
    const glyph = anyRunning ? "•" : "✓";
    const color = anyRunning ? "yellow" : "green";
    const noun = COLLAPSED_NOUN[name] ?? "calls";
    const last = entries[entries.length - 1]!;
    const lastArg = summarizeArgs(name, last.args);
    return (
        <Box marginBottom={1}>
            <Text color={color}>{glyph} </Text>
            <Text bold>{name}</Text>
            <Text dimColor>
                {" "}
                · {entries.length} {noun}
            </Text>
            {lastArg.length > 0 && (
                <Text dimColor>
                    {" "}
                    · {lastArg.slice(0, 80)}
                    {lastArg.length > 80 ? "…" : ""}
                </Text>
            )}
            {interactive && <Text dimColor> (ctrl+o to expand)</Text>}
        </Box>
    );
});
GroupView.displayName = "GroupView";

interface RenderUnitProps {
    readonly unit: RenderUnit;
    readonly expanded: boolean;
    readonly interactive: boolean;
}

const RenderUnitView = ({ unit, expanded, interactive }: RenderUnitProps) => {
    if (unit.kind === "single") return <RenderItem item={unit.item} />;
    return (
        <GroupView
            name={unit.name}
            entries={unit.entries}
            expanded={expanded}
            interactive={interactive}
        />
    );
};

export const Chat = ({
    items,
    streamingText,
    streaming,
    committedCount,
    groupsExpanded,
}: ChatProps) => {
    // Stable commit boundary: items[0..committedCount) are eligible for Ink's
    // <Static> (scrollback). Static is append-only — re-rendering a previously
    // rendered item is a no-op — so we hold the boundary back until the
    // streaming session ends. That lets consecutive Read/Glob/Grep entries
    // continue merging into a single group as they arrive without breaking
    // Static's invariant.
    const committedItems = items.slice(0, committedCount);
    const dynamicItems = items.slice(committedCount);

    const committedUnits = groupItems(committedItems);
    const dynamicUnits = groupItems(dynamicItems);

    // While a tool is mid-execution, its own running indicator (and progress
    // panel for Task) signals liveness — the generic Thinking spinner becomes
    // misleading and visually competes with the tool entry.
    const hasRunningTool = dynamicItems.some(
        (item) => item.kind === "toolCall" && item.entry.status === "running",
    );

    return (
        <>
            <Static items={committedUnits as RenderUnit[]}>
                {(unit) => (
                    <Box key={unit.key} paddingX={1}>
                        <RenderUnitView unit={unit} expanded={false} interactive={false} />
                    </Box>
                )}
            </Static>
            <Box flexDirection="column" paddingX={1}>
                {dynamicUnits.map((unit) => (
                    <RenderUnitView
                        key={unit.key}
                        unit={unit}
                        expanded={groupsExpanded}
                        interactive={true}
                    />
                ))}
                {streaming &&
                    !hasRunningTool &&
                    (streamingText.length > 0 ? (
                        <AssistantLine content={streamingText} />
                    ) : (
                        <Thinking />
                    ))}
            </Box>
        </>
    );
};
