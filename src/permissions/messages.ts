// Single source of truth for denial messages. No other file in Ye should
// emit a denial string inline. Add new constants here when new denial reasons
// are introduced. The text is stable so the model can pattern-match across turns.

export const USER_DENIED = "User denied this action.";

export const PLAN_MODE_BLOCKED =
    "Tool blocked: PLAN mode allows Read, Glob, Grep, AskUserQuestion, WebFetch, WebSearch, ExitPlanMode only. " +
    "Either call ExitPlanMode with a proposed plan, or stop and ask the user " +
    "to switch modes via Shift+Tab.";
