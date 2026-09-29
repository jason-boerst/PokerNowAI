## PokerNow GPT

![Demo](assets/demo.png)

An LLM-powered poker assistant for [PokerNow](https://www.pokernow.club). It reads the live table (stakes, your hole cards, positions, stacks, actions, board, pot) and each opponent's VPIP/PFR from a local SQLite cache, sends that to a language model, and either shows the suggested action in an overlay (assistant mode) or clicks it for you (auto-play mode).

This is a fork of [JaimeYeung/PokerNow-AI](https://github.com/JaimeYeung/PokerNow-AI), which is itself based on [csong2022/pokernow-gpt](https://github.com/csong2022/pokernow-gpt). Changes in this fork:

- **One OpenRouter key, every model.** OpenRouter is the default provider. At startup you pick from a searchable menu of every model OpenRouter lists, with prices.
- **Any model, including the newest.** The hardcoded model allowlist (GPT-4o era, Gemini 1.x) is gone. Any model ID your provider serves works.
- **Claude support** through the official [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript).
- **OpenAI-compatible endpoints** (xAI, DeepSeek, Ollama, LM Studio, ...) via a base URL.
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
- An [OpenRouter](https://openrouter.ai) API key with credits. (Alternatively, a direct key from Anthropic, OpenAI or Google; see "Other providers" below.)

## Install

```sh
git clone https://github.com/jason-boerst/PokerNowAI.git
cd PokerNowAI
npm install
cp .env.example .env      # Windows (cmd): copy .env.example .env
```

Open `.env` in a text editor (`open -e .env` on macOS, `notepad .env` on Windows, `nano .env` on Linux) and fill in your key:

```env
OPENROUTER_API_KEY=sk-or-...
```

That is the only required setting.

`npm install` also downloads a bundled Chrome for puppeteer (used when `use_existing_browser` is `false`). To skip that download, set `PUPPETEER_SKIP_DOWNLOAD=1` before installing.

## Choose a model

When you run `npm start` or `npm run test-ai`, a menu lists every model OpenRouter currently offers:

```
OpenRouter currently lists 312 models.
Search models (e.g. "claude", "gpt", "gemini", "free"), type "all", or a number from the list: claude
    1. anthropic/...  (in $3.00 / out $15.00 per 1M tokens, supports effort)
    2. anthropic/...  (in $1.00 / out $5.00 per 1M tokens, supports effort)
Search models ...: 1
Using model: anthropic/...
```

- Type words to search model IDs and names (every word must match), then type the number of the one you want.
- `all` lists everything; you can also type an exact model ID.
- Your choice is saved in `.last-model`, so next time you can just press Enter to reuse it.
- "supports effort" means OpenRouter reports that the model accepts a reasoning setting (see `AI_EFFORT` below).

Prices are shown as OpenRouter reports them, in US dollars per million tokens. The model count and names above are illustrative; your menu shows the live list.

### Optional settings in `.env`

| Setting | Effect |
|---|---|
| `AI_MODEL=provider/model-name` | Always use this model and skip the menu. |
| `AI_EFFORT=low` | Reasoning effort (`low`, `medium`, `high`) for models that support it, sent as OpenRouter's `reasoning: { effort }`. Unset by default, which uses the model's default. Lower effort is usually faster. |
| `AI_PLAYSTYLE=neutral` | `neutral`, `aggressive`, `passive` or `pro`. |

These override `app/configs/ai-config.json`, which you can also edit directly (`provider`, `model_name`, `playstyle`, `effort`, `request_timeout_ms`). Leave `model_name` empty there to get the menu.

`npm run list-models` prints the full OpenRouter list with prices without starting anything.

**Speed matters:** PokerNow turns are timed, and I have not measured how fast any particular model answers. `npm run test-ai` prints the latency for one sample spot; pick a model and effort that answer comfortably inside your table's turn timer.

### Other providers

You can skip OpenRouter and call a provider directly by setting `AI_PROVIDER` and its key in `.env`:

| `AI_PROVIDER` | Key variable | Notes |
|---|---|---|
| `Anthropic` | `ANTHROPIC_API_KEY` | Claude models, e.g. `claude-opus-5-5` ([model list](https://platform.claude.com/docs/en/models/overview)). Sends `effort` as `output_config.effort`, and enables server-side refusal fallbacks on Opus 5.5, Sonnet 5.5, Opus 5 and Fable 5.1. |
| `OpenAI` | `OPENAI_API_KEY` | Sends `effort` as `reasoning_effort`. |
| `Google` | `GOOGLEAI_API_KEY` | Sends `effort` as `thinkingConfig.thinkingLevel`. |
| `OpenAICompatible` | `OPENAI_COMPATIBLE_API_KEY` | Any OpenAI-style API; also set `OPENAI_COMPATIBLE_BASE_URL` (e.g. `http://localhost:11434/v1` for Ollama). |

For these, set `AI_MODEL` too (the menu is OpenRouter-only); `npm run list-models` shows the IDs each key can use.

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

1. Pick a model from the menu (or press Enter to reuse your last one).
2. The terminal asks for the game. Paste the ID (`pgl-3YEOMYb8pdkfOtoGwyHPQ`) or the full URL. You can also pass it directly: `npm start -- https://www.pokernow.club/games/pgl-...`
3. In the Chrome window, open the game, click an empty seat, enter a name and stack, and wait for the host to approve.
4. Once seated, the bot monitors the table. On your turn a suggestion appears in the top-right corner; hover it for the reasoning.

**Switching models mid-game:** while the bot runs, type `m` in its terminal and press Enter. The model menu opens (bot messages are held back until you finish), and the model you pick is used from the next suggestion; you stay seated. `m provider/model-name` switches directly, and `q` in the menu cancels. The choice is also saved as your default for next time.

Manual steps: `npm run chrome` in one terminal, `npm run start:bot` in another. If Chrome is not found, set `CHROME_PATH` in `.env` to the browser executable.

### Assistant mode vs auto-play

| | Assistant mode | Auto-play mode |
|---|---|---|
| Who clicks | You | The bot |
| Browser | Your visible Chrome window | Your Chrome window, or a headless browser the bot launches if `webdriver-config.json` has `"use_existing_browser": false` |
| Config | `bot-config.json`: `"assistant_mode": true` | `bot-config.json`: `"assistant_mode": false` (the bot asks for a name and stack and requests the seat itself) |

## How decisions are made

- **Preflop:** a rule-based engine answers instantly, with no AI call. It covers unopened pots, limpers, a raise (with or without callers), 3-bets and 4-bets, and adjusts for opponents' stats: bigger raises when the players left to act or the limpers call too much, wider value 3-bets against loose raisers, tighter play against nits, and folding small pairs when stacks are too short to set-mine. The ranges and sizes are in `app/configs/preflop-ranges.json`. They are hand-built approximations for loose full-ring games, not solver output, and you can edit them. Set `"preflop_engine": false` in `app/configs/bot-config.json` to use the AI preflop instead.
- **Flop, turn and river:** the AI model, with the `[Engine]` equity estimate printed alongside.

## Measuring how well it plays

Every decision and every finished hand is recorded in `app/pokernow-gpt.db` while the bot runs.

| Command | What it does |
|---|---|
| `npm run stats` | Your results in bb/100 with a 95% confidence interval, overall and per model. Poker is noisy: expect "can't tell yet" for a long time (tens of thousands of hands). |
| `npm run label` | Shows recorded spots (cards, full action history, pot, odds) and lets you enter the correct play. |
| `npm run eval -- --models a/x,b/y` | Replays recorded spots through each model: % legal actions, agreement with your labels, latency. Costs API credits; asks first. |
| `npm run players` | Opponent profiles from all recorded hands: type (calling station, nit, maniac, loose-passive, TAG, LAG), key stats with sample sizes, and the main exploit. `npm run players -- <name>` adds their recent showdowns. |
| `npm run export-hands` | Writes hands and decisions to `hand-export.json` with player names anonymized. |

While playing, each turn prints a `[State]` line (position, street, pot, amount to call, pot odds, min raise, effective stack, SPR). If it doesn't match the table, please report it.

Each turn also prints an `[Engine]` line: your equity (share of the pot you'd win on average) against each remaining opponent's estimated range, and the equity you need to call. Ranges come from each player's VPIP/PFR (population defaults until a player has 20 hands) and their actions this hand. They are estimates built on stated assumptions, not solver output.

## Troubleshooting

- **The bot stops or seems stuck after opening the game:** with the game open in the bot's Chrome window, run `npm run diagnose` in a second terminal. It lists which table elements the bot can see (element counts and the blinds text only, no names or cards). If items marked "expected always" are missing while the table is visible, PokerNow has changed its page layout and the bot's selectors need updating.
- **"Failed to pull logs: ..."** the message after the colon says why (HTTP status, not JSON, no hand start found). The game log is fetched from inside the game tab, so the game must stay open in the bot's Chrome window. `npm run diagnose` also checks the log and prints its newest entries with player names hidden.
- **"Could not read the blinds from the page":** the bot shows the text it found and asks you to type the blinds (e.g. `10/20`). Please report that text so the parser can be fixed.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # offline unit tests
npm run test:live   # upstream tests that hit live PokerNow game logs (the game IDs in them may have expired)
```

## License

MIT. See `LICENSE`.
