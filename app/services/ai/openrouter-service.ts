import { OpenAIService } from "./openai-service.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter serves every model through one OpenAI-compatible API, so this reuses OpenAIService.
// The only difference is how reasoning effort is sent: OpenRouter uses a unified
// `reasoning: { effort }` field and translates it for each underlying model.
export class OpenRouterService extends OpenAIService {
    protected effortParams(effort: string): object {
        return { reasoning: { effort } };
    }
}
