export type MailboxStatus = "queued" | "delivered" | "rejected";

export interface MailboxMessage {
    readonly id: string;
    readonly text: string;
    readonly queuedAt: number;
    status: MailboxStatus;
    rejection: string;
}

export type EnqueueResult =
    | { readonly ok: true; readonly message: MailboxMessage }
    | { readonly ok: false; readonly error: string };

// The half of a mailbox the pipeline is given: it can take messages out and
// refuse them, never put them in. Steering is UI-driven, so the model must not
// reach a path that lets it write to its own inbox.
export interface MailboxDrain {
    drain(): readonly MailboxMessage[];
    hasQueued(): boolean;
    rejectQueued(reason: string): void;
}

export interface MailboxOptions {
    readonly onDelivered?: (message: MailboxMessage) => void;
}

let seq = 0;

export class SubagentMailbox implements MailboxDrain {
    private readonly log: MailboxMessage[] = [];
    private closedReason = "";
    private readonly onDelivered: ((message: MailboxMessage) => void) | undefined;

    constructor(options: MailboxOptions = {}) {
        this.onDelivered = options.onDelivered;
    }

    enqueue(text: string): EnqueueResult {
        const trimmed = text.trim();
        if (trimmed.length === 0) return { ok: false, error: "message is empty" };
        if (this.closedReason.length > 0) {
            return { ok: false, error: `not delivered — ${this.closedReason}` };
        }
        const message: MailboxMessage = {
            id: `steer-${++seq}`,
            text: trimmed,
            queuedAt: Date.now(),
            status: "queued",
            rejection: "",
        };
        this.log.push(message);
        return { ok: true, message };
    }

    drain(): readonly MailboxMessage[] {
        const out: MailboxMessage[] = [];
        for (const message of this.log) {
            if (message.status !== "queued") continue;
            message.status = "delivered";
            out.push(message);
        }
        // Notify only after every message has flipped, so a callback that reads
        // the mailbox back sees one consistent state rather than a half-drain.
        for (const message of out) this.onDelivered?.(message);
        return out;
    }

    hasQueued(): boolean {
        return this.log.some((message) => message.status === "queued");
    }

    rejectQueued(reason: string): void {
        for (const message of this.log) {
            if (message.status !== "queued") continue;
            message.status = "rejected";
            message.rejection = reason;
        }
    }

    close(reason: string): void {
        if (this.closedReason.length > 0) return;
        this.closedReason = reason;
        this.rejectQueued(`not delivered — ${reason}`);
    }

    isClosed(): boolean {
        return this.closedReason.length > 0;
    }

    queued(): readonly MailboxMessage[] {
        return this.log.filter((message) => message.status === "queued");
    }

    rejected(): readonly MailboxMessage[] {
        return this.log.filter((message) => message.status === "rejected");
    }

    messages(): readonly MailboxMessage[] {
        return this.log;
    }
}
