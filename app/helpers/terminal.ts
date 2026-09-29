import { createInterface } from "node:readline/promises";

/**
 * Asks a question in the terminal and returns the trimmed answer.
 * Uses Node's readline, which handles pasted text and long lines correctly.
 */
export async function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl+C at a prompt exits the program
    rl.on("SIGINT", () => {
        rl.close();
        process.exit(130);
    });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
}
