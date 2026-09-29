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
4. Once seated, the bot monitors the table. On your turn a panel appears in the top-right corner. Its color is the action: **red = fold, yellow = check, green = call, bet, raise or all-in.** From top to bottom:
   - **Header:** who decided ("Preflop chart", "Engine · clear spot", "AI (model) · 70% confident", or "Engine · AI fallback"), plus the hand number, street, your seat and whether you're in position, so an old suggestion is obvious.
   - **Action banner:** what to do and how much, in big blinds, chips and share of the pot. While the AI is thinking it says "Provisional pick" with a countdown bar and shows the engine's pick; after your turn it turns grey and says "Previous turn".
   - **Bet label:** for bets and raises, "Value bet", "Semi-bluff" or "Bluff" plus lead, c-bet, barrel or stab, with a short reason.
   - **Key numbers:** equity (green when it beats the price, red when it doesn't), equity needed, pot, amount to call and SPR, in one line.
   - **Why:** always visible, the main reason in bold and up to four supporting points (measured fold rates, the EV comparison, margin notes).
   - **Warnings:** for example, the AI disagreeing with the engine, few hands on an opponent, or the game log lagging behind the table.
   - **Opponents:** one card per opponent still in the hand: seat, name, stack, type badge (nit, TAG, LAG, calling station, maniac...), "Acts after you", hands seen, estimated range. The one or two stats that matter most for this decision get a full row with a bar and a mark at your pool's average (for example "Fold to flop bet" when you could bet); the rest sit in a grid. Each stat shows its sample size and the pool average; orange with ▲ means well above the pool, blue with ▼ well below, grey means too few hands to judge. Then today's numbers, flagged changes (⚑), their last showdown and a one-line exploit.
   - **Odds:** an equity bar with a marker at the equity you need, and your equity when a bet gets called.
   - **Options:** every option with its rough EV as a bar (green positive, red negative), how often they fold or raise, and ▶ on the suggestion.
   - **Your hand** (cards, board, what you have, draws) and **Spot** (pot, to call, stacks, SPR, legal raise sizes, position).

   Drag the panel by its header; its position is remembered. Click a section title to collapse it (remembered), or the ▤ button for a compact view with just the action, key numbers and Why. The panel stops above PokerNow's action buttons and clicks on it never reach the table. To preview every panel state without a game: `npx tsx scripts/panel-gallery.ts <folder>` writes PNG screenshots.

**Stopping:** the bot stops by itself, printing why, when you close the game tab or Chrome, when the tab leaves the game, when you've been unseated for 60 seconds, when fewer than 2 players have been at the table for 2 minutes, or when nothing has happened for 10 minutes. The limits are in `app/configs/bot-config.json` (`stop_after_unseated_seconds`, `stop_after_short_table_minutes`, `stop_after_idle_minutes`). Ctrl+C also stops it.

**Switching models mid-game:** while the bot runs, type `m` in its terminal and press Enter. The model menu opens (bot messages are held back until you finish), and the model you pick is used from the next suggestion; you stay seated. `m provider/model-name` switches directly, and `q` in the menu cancels. The choice is also saved as your default for next time.

Manual steps: `npm run chrome` in one terminal, `npm run start:bot` in another. If Chrome is not found, set `CHROME_PATH` in `.env` to the browser executable.

### Assistant mode vs auto-play

| | Assistant mode | Auto-play mode |
|---|---|---|
| Who clicks | You | The bot |
| Browser | Your visible Chrome window | Your Chrome window, or a headless browser the bot launches if `webdriver-config.json` has `"use_existing_browser": false` |
| Config | `bot-config.json`: `"assistant_mode": true` | `bot-config.json`: `"assistant_mode": false` (the bot asks for a name and stack and requests the seat itself) |

## How decisions are made

- **Game rules:** at the start the bot reads the game's rules from the PokerNow log and your stored hands: the action clock, the 7-2 bounty, antes and straddles. It prints them as a `[Rules]` line and shows the ones that change decisions (bounty, antes) in a "Table" line on the panel. If the clock isn't in the log it assumes `decision_seconds` (15 s).
- **Preflop:** a rule-based engine answers instantly, with no AI call. It covers unopened pots, limpers, raises, 3-bets, 4-bets and more, heads-up play, and 10-handed tables. It adjusts for:
  - **Straddles:** sizes scale from the straddle, and the straddler acts last.
  - **Antes:** with enough dead money it opens and defends wider.
  - **Stack depth:** tiers at 150 and 300 BB. Deeper, it calls more with pairs and suited hands, drops weak offsuit hands, and stops stacking off KK against 4-bets.
  - **The 3-bettor's measured 3-bet %:** tight, normal or loose ranges for 4-betting and calling.
  - **The 7-2 bounty:** raises 7-2 when the bounty makes it worth it.
  - **Opponents' stats:** bigger raises against callers, tighter against nits.
  - **Closing the action** (the big blind, or the heads-up small blind after a raise over your limp): call or fold by price. It compares your equity against the players still in, times the share a hand like yours keeps out of position, with the equity the call needs. So a 2x open is defended much wider than a 4x open. Near break-even spots say "Close spot". The realization shares are in `price_defense` in the same file.

  The ranges and sizes are in `app/configs/preflop-ranges.json` (hand-built approximations, not solver output; every section explains its assumptions and you can edit it). Set `"preflop_engine": false` in `app/configs/bot-config.json` to use the AI preflop instead.
- **Opponent ranges:** each opponent's likely hands come from their VPIP, PFR and 3-bet %, their seat, and what they did this hand (limp, raise, limp-raise, call, 3-bet...). Calling ranges favor playable hands (pairs, suited connectors) over offsuit junk. In bounty games raising ranges include some 7-2 bluffs.
- **Flop, turn and river:** the engine estimates the rough EV of each option (fold, check, call, bets of 1/3, 2/3 and full pot, a 1.5x-pot overbet on the turn or river with strong hands, and raises). It looks one reply ahead:
  - **When you check:** opponents behind may bet, at their measured "bets when checked to" rate.
  - **When you bet:** each opponent folds, calls with the strongest part of their range, or raises. The rates come from how players in your games actually answered the same kind of bet at a similar size on that street (a lead into the preflop raiser, a c-bet, a barrel, a stab), measured from your stored hands at every start. They're adjusted for this player's own fold and raise rates, and a little on the turn and river for how weak their range is on this board. In the hands this was built from, leads into the raiser got far fewer folds and more raises than c-bets, and small bets far fewer folds than big ones. The measured rates matched actual folds on every street.
  - **Bluffs need a margin:** a bluff or semi-bluff is only suggested if it beats checking (or calling/folding) by at least 0.5 BB or 5% of the pot, since it depends on the fold estimate. Otherwise the panel says "a bluff here is too close to call".
  - **Every bet is labeled** under the action: **Value bet** (green), **Semi-bluff** (amber) or **Bluff** (red), plus what kind of bet it is (lead into the preflop raiser, c-bet, barrel, stab). The lines below give the folds a bluff needs vs the folds expected, how often you'll get raised, and how players in your games answered that kind and size of bet, with the number of cases.
  - **Reading bets:** what a bet or raise means on each street is learned from the showdowns in your stored hands.

  It still ignores later streets, so treat the numbers as a guide.
  - **Clear spots** (the best option is ahead by at least 1 BB or 15% of the pot, or the only question is bet size): the engine answers instantly.
  - **Close spots:** the AI gets the full hand history, the engine's numbers, opponent profiles, your pool's averages and the table notes, and must reply in JSON within its time budget. Its answer is checked for legality; if it's illegal, unreadable or late, the engine's best option is used.
  - **AI time budget:** `llm_timeout_ms` (default 6 s), and never more than the game's clock minus 7 s for you to read and click. With a 15 s clock the AI gets 6 s; with 10 s it gets 3 s; under that it is skipped. The panel shows the engine's pick while the AI thinks.
  - **`ai_mode`** in `bot-config.json`: `"close_spots"` (default), `"off"` (engine only, instant), or `"always"`.
  - The terminal prints `[Engine]` (equity and EV per option) and `[Decision]` (who decided and why).

## Measuring how well it plays

Every decision and every finished hand is recorded in `app/pokernow-gpt.db` while the bot runs.

| Command | What it does |
|---|---|
| `npm run stats` | Your results in bb/100 with a 95% confidence interval, overall and per model, plus a Suggestions table: how often you followed each source's advice and your results when you did vs didn't. Poker is noisy: expect "can't tell yet" for a long time (tens of thousands of hands). |
| `npm run label` | Shows recorded spots (cards, full action history, pot, odds) and lets you enter the correct play. |
| `npm run eval -- --models a/x,b/y` | Replays recorded spots through each model: % legal actions, agreement with your labels, latency. Costs API credits; asks first. |
| `npm run players` | Opponent profiles from all recorded and imported hands: type (calling station, nit, maniac, loose-passive, TAG, LAG), key stats with sample sizes, and the main exploit. `npm run players -- <name or id>` adds game-by-game history and recent showdowns. See [Player database](#player-database-import-past-games). |
| `npm run export-hands` | Writes hands and decisions to `hand-export.json` with player names anonymized. |

While playing, each turn prints a `[State]` line (position, street, pot, amount to call, pot odds, min raise, effective stack, SPR). If it doesn't match the table, please report it.

Each turn also prints an `[Engine]` line: your equity (share of the pot you'd win on average) against each remaining opponent's estimated range, and the equity you need to call. Ranges come from each player's VPIP/PFR (population defaults until a player has 20 hands) and their actions this hand. They are estimates built on stated assumptions, not solver output.

## Player database: import past games

Every hand is stored in `app/pokernow-gpt.db` on your computer, keyed by PokerNow's player id (names change between games, ids don't). Past games come from PokerNow's log download, and live games are added as you play. Opponent stats from both feed every decision.

### Import logs

In a PokerNow game, open the **Log** and download it. The file is named `poker_now_log_<game id>.csv`. Then either:

- **Dashboard:** `npm run dashboard`, open http://localhost:4545, and drag the files onto the page (or click **Import logs**).
- **Terminal:** `npm run import -- ~/Downloads/poker_now_log_pglAbC.csv` (several files or a whole folder also work).
- **Folder:** put the files in a `logs/` folder in this project. `npm start` imports anything new in it each time it starts, and `npm run import` with no arguments does the same.

Importing the same file twice is safe: hands already stored are skipped. What's imported and how:

- **Complete hands only.** A hand in progress when you downloaded, or cut off at the start of the file, is skipped and counted.
- **PokerNow's download seems to keep only the newest 20,000 log lines** (roughly 600 to 850 hands in the logs tested). One of the test logs had exactly 20,000 lines and started at hand #120. The import results say when a file starts after hand #1. For long games, download the log partway through and again at the end: the imports merge without duplicates. Games you play with the bot running are recorded hand by hand, so the limit doesn't apply to them.
- **Which player is you:** found from the hole cards in the log ("Your hand is ..."), matched to your showdowns or to the seat that was dealt in exactly when you were. A log downloaded while you weren't playing has no hole cards, so it can't tell. Your ids are grouped under "YOU", so your own play gets its own profile.
- **Same person, different id:** PokerNow's "changed the ID" messages link ids automatically. Otherwise link them yourself on a player's page in the dashboard ("Same person") or with `npm run players -- link <id or name> <id or name>`. Undo with "Split out" or `npm run players -- unlink <id>`. Ids are never merged by name, because different people use the same name.
- **Game types:** Omaha hands and bomb pots count toward results (BB/100, net) but not toward the tendency stats, which are Hold'em only. 7-2 bounty payments count toward results.

### Dashboard

`npm start` opens it for you in the background and prints `Player stats: http://localhost:4545`: open that link in your browser. Without the bot, run `npm run dashboard`. It's only reachable from your own computer; set `DASHBOARD_PORT` in `.env` to change the port, or `DASHBOARD_PORT=0` to turn it off. It shows:

- **Now:** the game you're playing, refreshed every 15 seconds: how each player is playing today next to their usual numbers, with clear changes flagged.
- **Your games on average:** the typical opponent in your games (these averages are also what the bot assumes for players with little history).
- **Results:** for each suggestion source (preflop chart, post-flop engine, AI), how often you followed it and your results when you did vs when you didn't, luck-adjusted, with 95% ranges. It needs many hands before it says anything firm.

- **Players:** every opponent with hands, games, VPIP, PFR, 3-bet, limp, fold to 3-bet, c-bet, fold to c-bet, aggression, WTSD (went to showdown), W$SD (won at showdown), BB/100 and net result; "More stats" adds steals, folds to a bet on each street, raises vs a bet and bets when checked to. Search, set a minimum number of hands, and click a column to sort. Each percentage shows its sample size.
- **A player's page:** all their stats with raw counts, VPIP by position, average bet size, how their most recent game differed from their usual play, a game-by-game table, the cards they've shown with the line they played, and their ids.
- **Games:** every game, and for one game, how each player played in it next to their usual numbers from every other game, with clear changes flagged. Tick "Refresh every 15 seconds" on the game you're playing to watch it live while the bot records hands.


### How the history is used at the table

- **Long-term:** a player's hands from every other game. **This session:** their hands from the game you're playing now (including any you imported from it earlier).
- The stats the engine uses are this session's numbers blended toward the player's own long-term numbers (their history counts as 30 chances of evidence), so a player who is clearly playing differently today moves the estimate, and a few odd hands don't.
- Players with little or no history are assumed to play like the average opponent in your stored games (not you). These averages are recomputed every time the bot starts, so they track your player pool as you import and record more hands; the built-in guesses only matter while the database is small (they count as 200 chances). The terminal prints the averages at startup.
- A change is flagged when a stat has at least 15 chances this session and differs from their usual number by more than 10 points and about two standard errors. Checked stats: VPIP, PFR, aggression, 3-bet, fold to c-bet and going to showdown.
- These estimates set the opponent ranges and fold and aggression rates in the equity and EV numbers, the preflop adjustments, and the opponent section of the AI prompt (which lists long-term and session numbers and any flagged changes). The overlay shows each opponent's history as "N before + M today hands", their usual VPIP/PFR next to today's, and a ⚑ line for each flagged change.
- Hundreds of hands are needed before most stats settle: a 20% stat measured over 100 chances has a standard error of about 4 points. The sample size is shown next to every number so you can judge.

The database and logs stay on your computer: `*.db` and `logs/` are in `.gitignore`.

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
