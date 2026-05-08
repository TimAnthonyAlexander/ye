import { AskUserQuestionTool } from "./askUserQuestion/index.ts";
import { BashTool } from "./bash/index.ts";
import { EditTool } from "./edit/index.ts";
import { EnterPlanModeTool } from "./enterPlanMode/index.ts";
import { ExitPlanModeTool } from "./exitPlanMode/index.ts";
import { GlobTool } from "./glob/index.ts";
import { GrepTool } from "./grep/index.ts";
import { ReadTool } from "./read/index.ts";
import { SkillTool } from "./skill/index.ts";
import { TaskTool } from "./task/index.ts";
import { TodoWriteTool } from "./todoWrite/index.ts";
import type { Tool } from "./types.ts";
import { WebFetchTool } from "./webFetch/index.ts";
import { WebSearchTool } from "./webSearch/index.ts";
import { WriteTool } from "./write/index.ts";

const TOOLS: readonly Tool[] = [
    ReadTool,
    EditTool,
    WriteTool,
    BashTool,
    GrepTool,
    GlobTool,
    TodoWriteTool,
    ExitPlanModeTool,
    EnterPlanModeTool,
    AskUserQuestionTool,
    TaskTool,
    WebFetchTool,
    WebSearchTool,
    SkillTool,
];

const TOOLS_BY_NAME: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): Tool | undefined => TOOLS_BY_NAME.get(name);

export const listTools = (): readonly Tool[] => TOOLS;
