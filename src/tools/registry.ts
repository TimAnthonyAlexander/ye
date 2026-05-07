import { BashTool } from "./bash/index.ts";
import { EditTool } from "./edit/index.ts";
import { ExitPlanModeTool } from "./exitPlanMode/index.ts";
import { GlobTool } from "./glob/index.ts";
import { GrepTool } from "./grep/index.ts";
import { ReadTool } from "./read/index.ts";
import { TodoWriteTool } from "./todoWrite/index.ts";
import type { Tool } from "./types.ts";
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
];

const TOOLS_BY_NAME: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): Tool | undefined => TOOLS_BY_NAME.get(name);

export const listTools = (): readonly Tool[] => TOOLS;
