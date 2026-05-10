// Deterministic Bash command risk classification. No LLM, no I/O.
// Every match elevates the command to a prompt in AUTO mode — never blocks.
// The user can always allow through if they recognise the command.
//
// Quote handling: most patterns target the *normalized* command (with quoted
// string contents stripped) so `echo "rm -rf x"` no longer false-positives on
// the rm pattern. Patterns whose payload is intentionally inside quotes
// (SQL via psql -c '...', curl|sh chains, fork bombs, persistent shell-config
// echos) target the raw command instead.
//
// Known limitation: `bash -c '<dangerous>'` style invocations are not caught
// by the shell-token patterns once normalized. The user should rely on the
// raw-target executor patterns or an explicit deny rule for these.

import type { HeuristicReason } from "./types.ts";

export type BashRisk =
    | { readonly kind: "allow" }
    | { readonly kind: "prompt"; readonly reason: HeuristicReason };

interface HeuristicPattern {
    readonly id: string;
    readonly label: string;
    readonly pattern: RegExp;
    // "normalized" → run against the command with quoted strings stripped.
    // "raw"        → run against the command verbatim. Use for patterns whose
    //                target text is intentionally embedded in quotes.
    readonly target: "normalized" | "raw";
}

const PATTERNS: readonly HeuristicPattern[] = [
    // --- Filesystem destruction ---
    {
        id: "rm-recursive",
        label: "rm with -r/-R/-fr (recursive removal)",
        pattern: /\brm\s+(?:[^|;&]*\s)?-[a-zA-Z]*[rR]/,
        target: "normalized",
    },
    {
        id: "find-delete",
        label: "find with -delete",
        pattern: /\bfind\b[^|;&]*-delete\b/,
        target: "normalized",
    },

    // --- Git lossy operations ---
    {
        id: "git-push-force",
        label: "git push with --force or -f",
        // --force-with-lease is the safer alternative — exempted via lookahead.
        pattern: /\bgit\s+push\s+(?:.*\s)?(?:--force(?!-with-lease)\b|-f\b)/,
        target: "normalized",
    },
    {
        id: "git-reset-hard",
        label: "git reset --hard (discards working tree)",
        pattern: /\bgit\s+reset\s+--hard\b/,
        target: "normalized",
    },
    {
        id: "git-clean",
        label: "git clean -f (deletes untracked files)",
        pattern: /\bgit\s+clean\s+-[fdx]+\b/,
        target: "normalized",
    },
    {
        id: "git-checkout-discard",
        label: "git checkout that discards changes (-- or .)",
        pattern: /\bgit\s+checkout\s+(?:\.|--)/,
        target: "normalized",
    },
    {
        id: "git-rm-recursive",
        label: "git rm -r (recursive)",
        pattern: /\bgit\s+rm\s+(?:.*\s)?-[a-zA-Z]*r/,
        target: "normalized",
    },
    {
        id: "git-update-ref-delete",
        label: "git update-ref -d (deletes a ref)",
        pattern: /\bgit\s+update-ref\s+-d\b/,
        target: "normalized",
    },
    {
        id: "git-reflog-expire",
        label: "git reflog expire",
        pattern: /\bgit\s+reflog\s+expire\b/,
        target: "normalized",
    },
    {
        id: "git-filter-branch",
        label: "git filter-branch (rewrites history)",
        pattern: /\bgit\s+filter-branch\b/,
        target: "normalized",
    },
    {
        id: "git-stash-loss",
        label: "git stash drop/clear/pop (can lose stashed work)",
        pattern: /\bgit\s+stash\s+(?:drop|clear|pop)\b/,
        target: "normalized",
    },
    {
        id: "git-rebase-interactive",
        label: "git rebase -i (interactive rewrite)",
        pattern: /\bgit\s+rebase\s+-i\b/,
        target: "normalized",
    },
    {
        id: "git-commit-amend",
        label: "git commit --amend (rewrites last commit)",
        pattern: /\bgit\s+commit\s+--amend\b/,
        target: "normalized",
    },

    // --- Privilege escalation ---
    {
        id: "sudo",
        label: "sudo",
        pattern: /\bsudo\s/,
        target: "normalized",
    },

    // --- Permission changes ---
    {
        id: "chmod-777",
        label: "chmod 777 (world-writable)",
        pattern: /\bchmod\s+.*777\b/,
        target: "normalized",
    },
    {
        id: "chmod-recursive",
        label: "chmod -R (recursive)",
        pattern: /\bchmod\s+-R\b/,
        target: "normalized",
    },
    {
        id: "chown-recursive",
        label: "chown -R (recursive)",
        pattern: /\bchown\s+-R\b/,
        target: "normalized",
    },

    // --- Disk / device ---
    {
        id: "mkfs",
        label: "mkfs (format filesystem)",
        pattern: /\bmkfs\./,
        target: "normalized",
    },
    {
        id: "dd-to-device",
        label: "dd writing to /dev/*",
        pattern: /\bdd\s+if=.*of=\/dev\//,
        target: "normalized",
    },
    {
        id: "mount-device",
        label: "mount /dev/*",
        pattern: /\bmount\s+.*\/dev\//,
        target: "normalized",
    },

    // --- Network execution (raw — payload is by design inside the pipe) ---
    {
        id: "curl-pipe-shell",
        label: "curl piped to shell",
        pattern: /\bcurl\s+.*\|.*\b(?:sh|bash|zsh|dash)\b/,
        target: "raw",
    },
    {
        id: "wget-pipe-shell",
        label: "wget piped to shell",
        pattern: /\bwget\s+.*-O\s*-\s*\|.*\b(?:sh|bash|zsh|dash)\b/,
        target: "raw",
    },
    {
        id: "curl-tee-or-dd",
        label: "curl/wget piped to tee or dd",
        pattern: /\b(?:curl|wget)\s.*\|\s*(?:tee|dd)\b/,
        target: "raw",
    },

    // --- Obfuscated payload eval (raw — payload sits inside $(...)) ---
    {
        id: "eval-base64",
        label: "eval/sh of base64-decoded payload",
        pattern: /\b(?:eval|sh|bash)\s+.*\$\(.*base64\s+-d/,
        target: "raw",
    },
    {
        id: "eval-xxd",
        label: "eval/sh of xxd-decoded payload",
        pattern: /\b(?:eval|sh|bash)\s+.*\$\(.*xxd\s+-r/,
        target: "raw",
    },

    // --- Fork bombs (raw — the literal characters matter) ---
    {
        id: "fork-bomb-shell",
        label: "shell fork bomb",
        pattern: /:\(\)\s*\{/,
        target: "raw",
    },
    {
        id: "fork-bomb-perl",
        label: "perl fork bomb",
        pattern: /\bperl\s+-e.*\bfork\b/,
        target: "raw",
    },

    // --- Database destruction (raw — SQL is delivered inside -c '...') ---
    {
        id: "drop-table",
        label: "DROP TABLE",
        pattern: /\bdrop\s+table\b/i,
        target: "raw",
    },
    {
        id: "drop-database",
        label: "DROP DATABASE",
        pattern: /\bdrop\s+database\b/i,
        target: "raw",
    },
    {
        id: "truncate-table",
        label: "TRUNCATE TABLE",
        pattern: /\btruncate\s+table\b/i,
        target: "raw",
    },

    // --- Container data loss ---
    {
        id: "docker-system-prune",
        label: "docker system prune",
        pattern: /\bdocker\s+system\s+prune\b/,
        target: "normalized",
    },
    {
        id: "docker-volume-rm",
        label: "docker volume rm",
        pattern: /\bdocker\s+volume\s+rm\b/,
        target: "normalized",
    },
    {
        id: "docker-volume-prune",
        label: "docker volume prune",
        pattern: /\bdocker\s+volume\s+prune\b/,
        target: "normalized",
    },

    // --- Cloud / orchestration ---
    {
        id: "kubectl-delete",
        label: "kubectl delete",
        pattern: /\bkubectl\s+delete\b/,
        target: "normalized",
    },
    {
        id: "terraform-destroy",
        label: "terraform destroy",
        pattern: /\bterraform\s+destroy\b/,
        target: "normalized",
    },
    {
        id: "aws-s3-rb-force",
        label: "aws s3 rb --force (delete bucket)",
        pattern: /\baws\s+s3\s+rb\s+.*--force\b/,
        target: "normalized",
    },
    {
        id: "gh-release-delete",
        label: "gh release delete",
        pattern: /\bgh\s+release\s+delete\b/,
        target: "normalized",
    },
    {
        id: "npm-publish",
        label: "npm publish",
        pattern: /\bnpm\s+publish\b/,
        target: "normalized",
    },

    // --- Persistent shell config mutation (raw — the appended payload is in quotes) ---
    {
        id: "rc-file-append",
        label: "append to ~/.bashrc / ~/.zshrc / ~/.profile",
        pattern: /\becho\s+.*>>\s*~\/\.(?:bashrc|zshrc|profile)/,
        target: "raw",
    },
    {
        id: "system-rc-append",
        label: "append to /etc/profile or /etc/environment",
        pattern: /\becho\s+.*>>\s*\/etc\/(?:profile|environment)/,
        target: "raw",
    },
];

// Replace contents of "..." and '...' with empty quotes. Lets shell-token
// patterns ignore string literals — `echo "rm -rf x"` becomes `echo ""`.
const stripQuotedStrings = (cmd: string): string =>
    cmd.replace(/"((?:\\.|[^"\\])*)"/g, '""').replace(/'([^']*)'/g, "''");

export const classifyBashCommand = (command: string): BashRisk => {
    const normalized = stripQuotedStrings(command);
    for (const p of PATTERNS) {
        const target = p.target === "raw" ? command : normalized;
        if (p.pattern.test(target)) {
            return { kind: "prompt", reason: { id: p.id, label: p.label } };
        }
    }
    return { kind: "allow" };
};
