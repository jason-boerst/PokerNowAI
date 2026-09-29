export interface GameInfo {
    game_type: string,
    big_blind: number,
    small_blind: number,
}

/**
 * Parses PokerNow's blinds display, e.g. "NLH~ 10 / 20". Tolerates missing or extra spaces,
 * non-breaking spaces, decimals, thousands separators, currency symbols and trailing ante values.
 * Returns null if no "small / big" pair can be found.
 */
export function parseGameInfo(text: string | null | undefined): GameInfo | null {
    if (!text) {
        return null;
    }
    const normalized = text
        .replace(/ /g, " ")
        .replace(/[$€£]/g, "")
        .replace(/(\d),(\d{3})/g, "$1$2");

    const blinds = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(normalized);
    if (!blinds) {
        return null;
    }
    const small_blind = Number(blinds[1]);
    const big_blind = Number(blinds[2]);
    if (!(small_blind > 0) || !(big_blind > 0)) {
        return null;
    }
    const game_type = /\b([A-Z]{2,}\d?)\b/.exec(normalized.slice(0, blinds.index))?.[1] ?? "NLH";
    return { game_type, small_blind, big_blind };
}
