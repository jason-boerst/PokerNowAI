// Sends one sample poker spot to the configured model and prints the parsed action.
// Use it to check your API key, model ID and effort setting without joining a game.
//   npm run test-ai
//   AI_PROVIDER=OpenAI AI_MODEL=<model> npm run test-ai
import dotenv from "dotenv";

import ai_config_json from "../app/configs/ai-config.json" with { type: "json" };
import { AIServiceFactory, resolveAIConfig } from "../app/helpers/ai-service-factory.ts";
import { chooseModelIfNeeded } from "../app/helpers/model-picker.ts";

dotenv.config();

const sample_query = [
    "Help me decide my action in No Limit Hold'em poker. I'm in the BTN position with a stack size of 98 BB.",
    "It is 2-handed, and the current street is: flop.",
    "The current community cards are: [Kh, 7d, 2c]",
    "My hole cards are: A♠, K♦",
    "The combination of the community cards and hand is: ONE_PAIR",
    "Here are the initial stack sizes of the other players in the pot, defined in the format {position: stack_size_in_BBs}:",
    "{BB: 104 BBs}",
    "The current pot size before any actions were made in the street is 5.5 BB.",
    "Here are the previous actions in this street, defined in the format {position action bet_size_in_BBs}:",
    "{BB checks}",
    "Here are the stats of the other players in the pot, defined in the format {position (name): Total Hands Played = total_hands, VPIP = vpip_stat, PFR = pfr_stat}:",
    "{BB (Villain): Total Hands Played = 40, VPIP = 0.55, PFR = 0.10}",
    "Respond in this format: {action, bet_size_in_BBs BB} two sentence reason. First sentence: explain the decision based on hand strength and position. Second sentence: mention the most relevant opponent (use their position and name) and how their stats influenced the decision. Example: {raise, 8 BB} Top pair with strong kicker justifies a raise for value. UTG (Shawn0627, VPIP=0.62) is a loose caller so a larger sizing extracts more value."
].join("\n");

const ai_config = await chooseModelIfNeeded(resolveAIConfig(ai_config_json));
console.log(`Provider: ${ai_config.provider}\nModel:    ${ai_config.model_name}\nEffort:   ${ai_config.effort ?? "model default"}\n`);

const start = Date.now();
try {
    const ai_service = new AIServiceFactory().createAIService(ai_config);
    ai_service.init();
    const res = await ai_service.query(sample_query, []);
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    console.log("Raw response:\n" + (res.curr_message?.text_content ?? "(none)") + "\n");
    console.log("Parsed action:", res.bot_action);
    console.log(`Latency: ${seconds}s`);
    if (!res.bot_action.action_str) {
        console.log("\nWARNING: no action could be parsed from the response.");
        process.exit(1);
    }
} catch (err) {
    console.error("Request failed:", err instanceof Error ? err.message : err);
    process.exit(1);
}
