## PokerNow GPT

![Demo](assets/demo.png)

An LLM-powered poker assistant for [PokerNow](https://www.pokernow.club). It reads the live table (stakes, your hole cards, positions, stacks, actions, board, pot) and each opponent's VPIP/PFR from a local SQLite cache, sends that to a language model, and either shows the suggested action in an overlay (assistant mode) or clicks it for you (auto-play mode).

This is a fork of [JaimeYeung/PokerNow-AI](https://github.com/JaimeYeung/PokerNow-AI), which is itself based on [csong2022/pokernow-gpt](https://github.com/csong2022/pokernow-gpt). Changes in this fork:

- **Any model, including the newest.** The hardcoded model allowlist (GPT-4o era, Gemini 1.x) is gone. Any model ID your provider serves works.
- **Claude support** through the official [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript).
- **OpenAI-compatible endpoints** (OpenRouter, xAI, DeepSeek, Ollama, LM Studio, ...) via a base URL.
- **Gemini moved to the current `@google/genai` SDK.** The old `@google/generative-ai` package is deprecated and its README states support ended on August 31, 2025 ([npm page](https://www.npmjs.com/package/@google/generative-ai)).
- **Reasoning effort setting** for models that support it.
- **Runs on macOS, Windows and Linux.** The macOS-only `start-chrome.sh` is replaced by a Node script that finds Chrome, Chromium or Edge.
- `npm run test-ai` checks your key and model without joining a game; `npm run list-models` shows the model IDs your keys can use.
- Dependencies upgraded (`npm audit` reports 0 vulnerabilities at the time of this change).

> **Terms of service:** automated play may violate PokerNow's rules or the rules of the game you join. Assistant mode only displays suggestions; auto-play mode clicks for you. Using either is your decision and your responsibility.

---

## Requirements

- **Node.js 22.12 or newer.** Current `puppeteer` and `openai` releases require it (check with `node -v`).
- **Google Chrome** (or Chromium / Microsoft Edge) for assistant mode.
- An API key for at least one provider: [Anthropic](https://platform.claude.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys), [Google AI Studio](https://aistudio.google.com/apikey), or any OpenAI-compatible endpoint.

## Install

```sh
git clone https://github.com/jason-boerst/PokerNowAI.git
cd PokerNowAI
npm install
cp .env.example .env      # Windows (cmd): copy .env.example .env
```

Put your key(s) in `.env`, for example:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

`npm install` also downloads a bundled Chrome for puppeteer (used when `use_existing_browser` is `false`). To skip that download, set `PUPPETEER_SKIP_DOWNLOAD=1` before installing.

## Choose a model

Edit `app/configs/ai-config.json`:

```json
{
    "provider": "Anthropic",
    "model_name": "claude-opus-5-5",
    "playstyle": "neutral",
    "effort": "low",
    "request_timeout_ms": 45000
}
```

| Field | Values |
|---|---|
| `provider` | `Anthropic`, `OpenAI`, `Google`, `OpenAICompatible` |
| `model_name` | Any model ID the provider serves. Run `npm run list-models` to see the exact IDs your keys can use. |
| `playstyle` | `neutral`, `aggressive`, `passive`, `pro` |
| `effort` | Optional. Sent as `output_config.effort` (Anthropic), `reasoning_effort` (OpenAI), or `thinkingConfig.thinkingLevel` (Google). Remove the line to use the model's default. Models without reasoning controls reject it, so remove it for those. |
| `base_url` | Only for `OpenAICompatible`, e.g. `https://openrouter.ai/api/v1` or `http://localhost:11434/v1` (Ollama). Can also be set as `OPENAI_COMPATIBLE_BASE_URL` in `.env`. |
| `request_timeout_ms` | Per-request timeout. |

You can override the JSON from `.env` or the command line without editing it: `AI_PROVIDER`, `AI_MODEL`, `AI_EFFORT`, `AI_PLAYSTYLE`, `AI_BASE_URL`.

```sh
AI_PROVIDER=OpenAI AI_MODEL=<model id> npm run test-ai
```

**Claude model IDs** (current list: [Anthropic models overview](https://platform.claude.com/docs/en/models/overview)): `claude-opus-5-5` (default here), `claude-sonnet-5-5` (cheaper per token), `claude-haiku-4-5` (cheapest; does not accept `effort`, so remove that line). For OpenAI and Google, use `npm run list-models` rather than a list in this README, because their catalogs change frequently and I did not verify current IDs for them.

**About `effort`:** it trades answer quality against latency and cost. The default here is `low` because PokerNow turns are timed; Claude Opus 5.5 defaults to `medium` if you omit it ([effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)). I have not measured decision quality or latency at different settings; `npm run test-ai` prints the latency for one sample spot so you can check it yourself.

For Claude Opus 5.5, Sonnet 5.5, Opus 5 and Fable 5.1, requests enable server-side refusal fallbacks (`fallbacks: "default"`), so if a safety classifier declines a request the API retries it on another model instead of returning nothing.

## Check that the model works

```sh
npm run test-ai
```

This sends one sample poker spot and prints the raw answer, the parsed action, and the latency. If it prints `Parsed action: { action_str: 'bet', ... }` you are ready.

## Run

```sh
npm start
```

This opens a dedicated Chrome window (with its own profile in `~/.pokernow-gpt/chrome-profile`, so a PokerNow login persists) and starts the bot. If a debuggable Chrome is already open on the port, it is reused.

1. The terminal asks for the game. Paste the ID (`pgl-3YEOMYb8pdkfOtoGwyHPQ`) or the full URL. You can also pass it directly: `npm start -- https://www.pokernow.club/games/pgl-...`
2. In the Chrome window, open the game, click an empty seat, enter a name and stack, and wait for the host to approve.
3. Once seated, the bot monitors the table. On your turn a suggestion appears in the top-right corner; hover it for the reasoning.

Manual steps: `npm run chrome` in one terminal, `npm run start:bot` in another. If Chrome is not found, set `CHROME_PATH` in `.env` to the browser executable.

### Assistant mode vs auto-play

| | Assistant mode | Auto-play mode |
|---|---|---|
| Who clicks | You | The bot |
| Browser | Your visible Chrome window | Your Chrome window, or a headless browser the bot launches if `webdriver-config.json` has `"use_existing_browser": false` |
| Config | `bot-config.json`: `"assistant_mode": true` | `bot-config.json`: `"assistant_mode": false` (the bot asks for a name and stack and requests the seat itself) |

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # offline unit tests
npm run test:live   # upstream tests that hit live PokerNow game logs (the game IDs in them may have expired)
```

## License

MIT. See `LICENSE`.
