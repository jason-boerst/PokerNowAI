export interface AIMessage {
    text_content: string,
    metadata: any
}

export interface AIResponse {
    bot_action: BotAction,
    prev_messages: AIMessage[],
    /** Absent when the model returned no usable answer (e.g. a refusal). */
    curr_message?: AIMessage
}

export interface AIServiceOptions {
    /** Provider-specific reasoning effort (see AIConfig.effort). */
    effort?: string,
    /** Override the provider's API base URL. */
    base_url?: string,
    /** Per-request timeout in milliseconds. */
    request_timeout_ms?: number
}

export abstract class AIService {
    private api_key: string;
    private model_name: string;
    private playstyle: string;
    private options: AIServiceOptions;

    constructor(api_key: string, model: string, playstyle: string, options: AIServiceOptions = {}) {
        this.api_key = api_key;
        this.model_name = model;
        this.playstyle = playstyle;
        this.options = options;
    }

    abstract init(): void;
    abstract query(input: string, prev_messages: AIMessage[]): Promise<AIResponse>;
    abstract processMessages(messages: AIMessage[]): Array<any>;

    getAPIKey(): string {
        return this.api_key;
    }

    getModelName(): string {
        return this.model_name;
    }

    /** Switches models; takes effect from the next query. */
    setModelName(model_name: string): void {
        this.model_name = model_name;
    }

    getPlaystyle(): string {
        return this.playstyle;
    }

    getOptions(): AIServiceOptions {
        return this.options;
    }
}

export interface BotAction {
    action_str: string,
    bet_size_in_BBs: number,
    reason?: string,
    /** This turn's random number and the mix it picked from (recorded with the decision). */
    rng?: { roll: number, style: string, mix: string, pick: string }
}

export const defaultCheckAction = {
    action_str: "check",
    bet_size_in_BBs: 0
}

export const defaultFoldAction = {
    action_str: "fold",
    bet_size_in_BBs: 0
}