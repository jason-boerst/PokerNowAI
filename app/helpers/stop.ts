/** Thrown to end the bot cleanly (table closed, game over, idle too long). Not an error. */
export class BotStopped extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "BotStopped";
    }
}
