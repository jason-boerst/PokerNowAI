import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AIMessage, AIResponse, AIService, BotAction } from "../../interfaces/ai-client-interfaces.ts";
import { appendUserInput, getPromptFromPlaystyle, parseResponse } from "../../helpers/ai-query-helper.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Models that accept server-side refusal fallbacks ("fallbacks": "default").
// If a safety classifier declines a request, the API retries it on a fallback model
// instead of returning an empty answer.
const SERVER_SIDE_FALLBACK_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

export class AnthropicService extends AIService {
    private agent!: Anthropic;

    init(): void {
        this.agent = new Anthropic({
            apiKey: this.getAPIKey(),
            timeout: this.getOptions().request_timeout_ms,
            // the bot has its own retry loop (query_retries), so keep SDK retries low
            maxRetries: 1
        });
    }

    // History handling is append-only: the system prompt never changes during a hand, and each
    // assistant turn is replayed with its original content blocks (including thinking blocks),
    // which newer Claude models require to be passed back unchanged.
    async query(input: string, prev_messages: AIMessage[]): Promise<AIResponse> {
        prev_messages = appendUserInput(prev_messages, input);

        const model = this.getModelName();
        const effort = this.getOptions().effort as Effort | undefined;
        const use_fallbacks = SERVER_SIDE_FALLBACK_MODELS.includes(model);

        const response = await this.agent.beta.messages.create({
            model: model,
            max_tokens: 16000,
            system: getPromptFromPlaystyle(this.getPlaystyle()),
            messages: this.processMessages(prev_messages),
            ...(effort ? { output_config: { effort } } : {}),
            ...(use_fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {})
        });

        let bot_action: BotAction = {
            action_str: "",
            bet_size_in_BBs: 0
        };

        if (response.stop_reason === "refusal") {
            console.log("Claude declined the request (stop_reason: refusal):", response.stop_details);
            return {
                bot_action: bot_action,
                prev_messages: prev_messages
            };
        }

        const text_content = response.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");

        if (text_content) {
            bot_action = parseResponse(text_content);
        }

        return {
            bot_action: bot_action,
            prev_messages: prev_messages,
            curr_message: {
                text_content: text_content,
                metadata: {
                    role: "assistant",
                    content: response.content
                }
            }
        };
    }

    processMessages(messages: AIMessage[]): BetaMessageParam[] {
        const output: BetaMessageParam[] = [];
        for (const message of messages) {
            if (message.metadata.role === "assistant") {
                output.push({
                    role: "assistant",
                    content: (message.metadata.content as BetaContentBlockParam[] | undefined) ?? message.text_content
                });
                continue;
            }
            // consecutive user turns (e.g. after a failed query) are merged into one message
            const last = output[output.length - 1];
            if (last && last.role === "user" && Array.isArray(last.content)) {
                last.content.push({ type: "text", text: message.text_content });
            } else {
                output.push({
                    role: "user",
                    content: [{ type: "text", text: message.text_content }]
                });
            }
        }
        return output;
    }
}
