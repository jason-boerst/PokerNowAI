import { Content, GoogleGenAI, HarmBlockThreshold, HarmCategory, ThinkingLevel } from "@google/genai";
import { AIMessage, AIResponse, AIService, BotAction } from "../../interfaces/ai-client-interfaces.ts";
import { appendUserInput, getPromptFromPlaystyle, parseResponse } from "../../helpers/ai-query-helper.ts";

const effortToThinkingLevel: Map<string, ThinkingLevel> = new Map<string, ThinkingLevel>([
    ["none", ThinkingLevel.MINIMAL],
    ["minimal", ThinkingLevel.MINIMAL],
    ["low", ThinkingLevel.LOW],
    ["medium", ThinkingLevel.MEDIUM],
    ["high", ThinkingLevel.HIGH],
    ["xhigh", ThinkingLevel.HIGH],
    ["max", ThinkingLevel.HIGH]
]);

export class GoogleAIService extends AIService {
    private agent!: GoogleGenAI;

    init(): void {
        const timeout = this.getOptions().request_timeout_ms;
        this.agent = new GoogleGenAI({
            apiKey: this.getAPIKey(),
            ...(timeout ? { httpOptions: { timeout } } : {})
        });
    }

    //takes an already created query and passes it into Gemini if it is the first action,
    //otherwise attaches it to previous queries and feeds the entire conversation into Gemini
    async query(input: string, prev_messages: AIMessage[]): Promise<AIResponse> {
        prev_messages = appendUserInput(prev_messages, input);

        const effort = this.getOptions().effort;
        const thinking_level = effort ? effortToThinkingLevel.get(effort) : undefined;

        const response = await this.agent.models.generateContent({
            model: this.getModelName(),
            contents: this.processMessages(prev_messages),
            config: {
                systemInstruction: getPromptFromPlaystyle(this.getPlaystyle()),
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
                ],
                ...(thinking_level ? { thinkingConfig: { thinkingLevel: thinking_level } } : {})
            }
        });
        const text_content = response.text ?? "";

        let bot_action: BotAction = {
            action_str: "",
            bet_size_in_BBs: 0
        };

        if (text_content) {
            bot_action = parseResponse(text_content);
        }

        return {
            bot_action: bot_action,
            prev_messages: prev_messages,
            curr_message: {
                text_content: text_content,
                metadata: {
                    role: "model",
                    // replay the model's original parts (including thought signatures) on later turns
                    content: response.candidates?.[0]?.content
                }
            }
        }
    }

    processMessages(messages: AIMessage[]): Content[] {
        const output: Content[] = [];
        for (const message of messages) {
            if (message.metadata.role === "model") {
                const content = message.metadata.content as Content | undefined;
                output.push(content?.parts ? { role: "model", parts: content.parts } : { role: "model", parts: [{ text: message.text_content }] });
                continue;
            }
            // consecutive user turns (e.g. after a failed query) are merged into one message
            const last = output[output.length - 1];
            if (last && last.role === "user") {
                last.parts!.push({ text: message.text_content });
            } else {
                output.push({ role: "user", parts: [{ text: message.text_content }] });
            }
        }
        return output;
    }
}
