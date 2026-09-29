import { HeroView } from "./hand-parser.ts";

export type ActionKind = "fold" | "check" | "call" | "bet" | "raise" | "all-in";

export interface SuggestedAction {
    action: ActionKind,
    /** For bet/raise: the total amount to bet/raise to, in big blinds. */
    size_bb: number
}

export interface LegalityResult {
    legal: boolean,
    /** Legal but never better than an alternative (e.g. folding when checking is free). */
    dominated: boolean,
    reason: string
}

const EPS = 1e-6;

/** Checks a suggested action against the spot. Amounts in `view` are chips; `size_bb` is in big blinds. */
export function checkLegality(a: SuggestedAction, view: HeroView, big_blind: number): LegalityResult {
    const ok = (reason = "ok"): LegalityResult => ({ legal: true, dominated: false, reason });
    const bad = (reason: string): LegalityResult => ({ legal: false, dominated: false, reason });
    const size = a.size_bb * big_blind;

    switch (a.action) {
        case "fold":
            return view.to_call > EPS ? ok() : { legal: true, dominated: true, reason: "folding when checking is free" };
        case "check":
            return view.to_call > EPS ? bad(`can't check facing a bet of ${round(view.to_call / big_blind)} BB`) : ok();
        case "call":
            return view.to_call > EPS ? ok() : bad("nothing to call (check instead)");
        case "all-in":
            return view.stack > EPS ? ok() : bad("no chips left");
        case "bet":
        case "raise": {
            // "bet" facing a bet is treated as a raise; models often mix the words up
            if (view.min_raise_to === null) return bad("raising isn't possible here");
            if (size > view.max_raise_to + EPS) return bad(`size ${round(a.size_bb)} BB is more than hero's stack (${round(view.max_raise_to / big_blind)} BB)`);
            const is_all_in = Math.abs(size - view.max_raise_to) < EPS;
            if (size + EPS < view.min_raise_to && !is_all_in) {
                return bad(`size ${round(a.size_bb)} BB is below the minimum of ${round(view.min_raise_to / big_blind)} BB`);
            }
            return ok();
        }
    }
    return bad(`unknown action "${a.action}"`);
}

function round(x: number): number {
    return Math.round(x * 100) / 100;
}

/** Parses a label or legacy bot action like "raise 3.5", "call", "all in". */
export function parseSuggestedAction(text: string): SuggestedAction | null {
    const t = text.trim().toLowerCase();
    const m = t.match(/^(fold|check|call|bet|raise|all.?in)\b\s*(?:to\s*)?([\d.]+)?/);
    if (!m) return null;
    const action = (m[1].startsWith("all") ? "all-in" : m[1]) as ActionKind;
    return { action, size_bb: m[2] ? Number(m[2]) : 0 };
}

/** True if two actions agree: same kind (bet and raise count as the same), sizes within 25%. */
export function actionsAgree(a: SuggestedAction, b: SuggestedAction): boolean {
    const kind = (x: SuggestedAction) => x.action === "bet" ? "raise" : x.action;
    if (kind(a) !== kind(b)) return false;
    if (kind(a) !== "raise" || !a.size_bb || !b.size_bb) return true;
    return Math.abs(a.size_bb - b.size_bb) / Math.max(a.size_bb, b.size_bb) <= 0.25;
}
