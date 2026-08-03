import { AskUserQuestionTool } from "./askUserQuestion/index.ts";
import { BashTool } from "./bash/index.ts";
import { BashOutputTool } from "./bashOutput/index.ts";
import { DiagnosticsTool } from "./diagnostics/index.ts";
import { EditTool } from "./edit/index.ts";
import { EnterPlanModeTool } from "./enterPlanMode/index.ts";
import { ExitPlanModeTool } from "./exitPlanMode/index.ts";
import { GlobTool } from "./glob/index.ts";
import { GrepTool } from "./grep/index.ts";
import { KillAgentTool } from "./killAgent/index.ts";
import { KillMonitorTool } from "./killMonitor/index.ts";
import { KillShellTool } from "./killShell/index.ts";
import { MonitorTool } from "./monitor/index.ts";
import { lspToolsAvailable } from "../lsp/availability.ts";
import { DefinitionTool, ReferencesTool, SymbolSearchTool } from "./lspTools/index.ts";
import { ReadTool } from "./read/index.ts";
import { SaveMemoryTool } from "./saveMemory/index.ts";
import { SkillTool } from "./skill/index.ts";
import { TaskOutputTool } from "./taskOutput/index.ts";
import { TaskTool } from "./task/index.ts";
import { TodoWriteTool } from "./todoWrite/index.ts";
import type { Tool } from "./types.ts";
import { WebFetchTool } from "./webFetch/index.ts";
import { WebSearchTool } from "./webSearch/index.ts";
import { WriteTool } from "./write/index.ts";

const LSP_TOOLS: readonly Tool[] = [DefinitionTool, ReferencesTool, SymbolSearchTool];

const TOOLS: readonly Tool[] = [
    ReadTool,
    EditTool,
    WriteTool,
    BashTool,
    BashOutputTool,
    GrepTool,
    GlobTool,
    ...LSP_TOOLS,
    DiagnosticsTool,
    TodoWriteTool,
    ExitPlanModeTool,
    EnterPlanModeTool,
    AskUserQuestionTool,
    TaskTool,
    TaskOutputTool,
    KillAgentTool,
    MonitorTool,
    KillMonitorTool,
    WebFetchTool,
    WebSearchTool,
    SkillTool,
    SaveMemoryTool,
    KillShellTool,
];

const TOOLS_BY_NAME: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

const LSP_TOOL_NAMES: ReadonlySet<string> = new Set(LSP_TOOLS.map((t) => t.name));

const TOOLS_WITHOUT_LSP: readonly Tool[] = TOOLS.filter((t) => !LSP_TOOL_NAMES.has(t.name));

export const getTool = (name: string): Tool | undefined => TOOLS_BY_NAME.get(name);

// The navigation tools are only useful with a configured language server; with
// none, they are dropped so the model never spends a turn calling them.
export const listTools = (): readonly Tool[] => (lspToolsAvailable() ? TOOLS : TOOLS_WITHOUT_LSP);

export const unknownToolError = (name: string): string => {
    const names = listTools().map((t) => t.name);
    const ciMatch = names.find((n) => n.toLowerCase() === name.toLowerCase());
    const suggestion = ciMatch && ciMatch !== name ? ` Did you mean "${ciMatch}"?` : "";
    return `unknown tool: ${name}.${suggestion} Available tools: ${names.join(", ")}.`;
};
