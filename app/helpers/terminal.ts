import { createInterface, Interface } from "node:readline/promises";

// One readline interface is shared by questions and live commands. While a question is
// pending, readline hands the typed line to the question; otherwise it is emitted as a
// "line" event for the command handler.
let shared: Interface | null = null;
let persistent = false;

function getInterface(): Interface {
    if (!shared) {
        shared = createInterface({ input: process.stdin, output: process.stdout });
        // Ctrl+C exits the program
        shared.on("SIGINT", () => {
            shared?.close();
            process.exit(130);
        });
    }
    return shared;
}

/**
 * Asks a question in the terminal and returns the trimmed answer.
 * Uses Node's readline, which handles pasted text and long lines correctly.
 */
export async function ask(question: string): Promise<string> {
    const rl = getInterface();
    try {
        return (await rl.question(question)).trim();
    } finally {
        // release stdin so short scripts can exit, unless live commands are listening
        if (!persistent) {
            rl.close();
            shared = null;
        }
    }
}

/** Calls `handler` for every line typed while no question is pending. Keeps stdin open. */
export function onCommand(handler: (line: string) => void): void {
    persistent = true;
    getInterface().on("line", handler);
}
