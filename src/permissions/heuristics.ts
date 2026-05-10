// Deterministic Bash command risk classification. No LLM, no I/O.
// Every pattern here elevates the command to a prompt in AUTO mode.
// No patterns hard-block — the user can always allow through if they
// recognise the command. Patterns are applied to the full command
// string so they catch both root commands and subshell abuse like
//   `find . -name '*.log' -exec rm {} \;`  → matched by `rm\s`
//   `echo "safe" && rm -rf /tmp/stuff`     → matched by `rm\s+-rf`

export type BashRisk = "prompt" | "allow";

// ---------------------------------------------------------------------------
// Single flat list — matched in order, first hit wins. Every match
// elevates the command to a prompt (never blocks). The user decides.
// ---------------------------------------------------------------------------

const PROMPT_PATTERNS: readonly RegExp[] = [
    // Recursive/force removal (any path)
    /\brm\s.*-[rR]/,

    // Chained rm (e.g. `cmd1; rm -rf x`)
    /rm\s.*[;|&].*\brm\b/,

    // Force-push, reset, clean, checkout-hard — lossy git operations
    /\bgit\s+push\s+.*--force/,
    /\bgit\s+reset\s+--hard/,
    /\bgit\s+reset\s+--soft\b/,
    /\bgit\s+clean\s+-[fdx]+\b/,
    /\bgit\s+checkout\s+\.\b/,
    /\bgit\s+checkout\s+--/,
    /\bgit\s+rm\b/,

    // Reflog / filter-branch
    /\bgit\s+reflog\s+expire\b/,
    /\bgit\s+filter-branch\b/,

    // Stash droppage
    /\bgit\s+stash\s+drop\b/,
    /\bgit\s+stash\s+clear\b/,

    // History rewriting
    /\bgit\s+rebase\s+-i\b/,
    /\bgit\s+commit\s+--amend\b/,

    // Fork bombs
    /:\(\)\s*\{/,
    /\bperl\s+-e.*\bfork\b/,

    // Pipe from curl/wget into a shell (could be Homebrew, could be hostile)
    /\bcurl\s+.*\|.*\b(?:sh|bash|zsh|dash)\b/,
    /\bwget\s+.*-O\s*-\s*\|.*\b(?:sh|bash|zsh|dash)\b/,

    // Curl/wget piped to tee/dd (saving a binary to disk)
    /\b(?:curl|wget)\s.*\|\s*(?:tee|dd)\b/,

    // Permission escalations
    /\bchmod\s+.*777\b/,
    /\bchmod\s+-R\b/,
    /\bchown\s+-R\b/,

    // Disk formatting / raw device writes
    /\bmkfs\./,
    /\bdd\s+if=.*of=\/dev\//,

    // Obfuscated payload evaluation
    /\b(?:eval|sh|bash)\s+.*\$\(.*base64\s+-d/,
    /\b(?:eval|sh|bash)\s+.*\$\(.*xxd\s+-r/,

    // sudo (any command — harmless or not, the user should know)
    /\bsudo\s/,

    // Mount abuse
    /\bmount\s+.*\/dev\//,

    // Database destruction
    /\bdrop\s+table\b/i,
    /\bdrop\s+database\b/i,
    /\btruncate\s+table\b/i,

    // Docker data loss
    /\bdocker\s+system\s+prune\b/,
    /\bdocker\s+volume\s+rm\b/,
    /\bdocker\s+volume\s+prune\b/,

    // Persistent shell config mutation
    /\becho\s+.*>>\s*~\/\.(?:bashrc|zshrc|profile)/,
    /\becho\s+.*>>\s*\/etc\/(?:profile|environment)/,
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const classifyBashCommand = (command: string): BashRisk => {
    for (const pattern of PROMPT_PATTERNS) {
        if (pattern.test(command)) return "prompt";
    }
    return "allow";
};
