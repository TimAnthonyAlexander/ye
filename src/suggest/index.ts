export { generateSuggestion, type GenerateSuggestionInput } from "./generate.ts";
export {
    lastRoleText,
    NO_SUGGESTION,
    reduceSuggestion,
    sanitizeSuggestion,
    shouldGenerateSuggestion,
    visibleSuggestion,
    type SuggestionEvent,
    type SuggestionGate,
    type SuggestionState,
    type SuggestionVisibility,
} from "./suggestion.ts";
