// Agreement-conditioned results: your hands split by whether every engine suggestion matched what
// you did, with all-in adjusted win rates for each group.
//
// Correlational only: agreement is confounded with the cards. The engine and you both fold most weak
// hands preflop (agreed, small losses) and both play strong hands (agreed, big wins), while the
// disagreements cluster in marginal spots. A gap between the groups is not the value of following
// the engine.
import { summarizeWinrate, WinrateSummary } from "../engine/winrate.ts";
import { HeroDecision, HeroHand, Kind } from "./replay.ts";

export type AgreementStreet = "preflop" | "flop" | "turn" | "river";
const STREETS: AgreementStreet[] = ["preflop", "flop", "turn", "river"];

export interface HandAgreement {
    /** Decisions with an engine suggestion, and how many matched, per street. */
    by_street: Record<AgreementStreet, { compared: number, matched: number }>,
    compared: number,
    matched: number,
    /** True when every compared decision matched (and there was at least one). */
    all_matched: boolean,
    result_bb: number
}

/** True when your action and the engine's are the same kind (bets and raises are one kind; sizes aren't compared). */
export function decisionMatches(d: Pick<HeroDecision, "actual" | "engine">): boolean | null {
    return d.engine ? d.engine.kind === d.actual : null;
}

/** Per-street agreement for one hand. */
export function classifyHand(decisions: Pick<HeroDecision, "street" | "actual" | "engine">[], result_bb: number): HandAgreement {
    const by_street = Object.fromEntries(STREETS.map((s) => [s, { compared: 0, matched: 0 }])) as HandAgreement["by_street"];
    let compared = 0, matched = 0;
    for (const d of decisions) {
        const m = decisionMatches(d);
        if (m === null) continue;
        const cell = by_street[d.street as AgreementStreet];
        cell.compared++;
        compared++;
        if (m) { cell.matched++; matched++; }
    }
    return { by_street, compared, matched, all_matched: compared > 0 && matched === compared, result_bb };
}

export interface GroupSplit {
    label: string,
    matched: WinrateSummary,
    unmatched: WinrateSummary
}

export interface AgreementReport {
    hands: number,
    /** Hands with no decision the engine could be compared on (e.g. a walk in the big blind). */
    no_decision: number,
    decisions: number,
    decision_agreement: number,
    /** Decision-level agreement per street. */
    street_agreement: Record<AgreementStreet, { compared: number, matched: number }>,
    /** Your action (rows) against the engine's (columns), counts. */
    confusion: Record<Kind, Record<Kind, number>>,
    overall: WinrateSummary,
    splits: GroupSplit[]
}

/** Win rates (all-in adjusted) for hands where the engine agreed with you and where it didn't. */
export function agreementReport(hands: HeroHand[]): AgreementReport {
    const kinds: Kind[] = ["fold", "check", "call", "raise"];
    const confusion = Object.fromEntries(kinds.map((a) => [a, Object.fromEntries(kinds.map((b) => [b, 0]))])) as AgreementReport["confusion"];
    const classified = hands.map((h) => {
        for (const d of h.decisions) if (d.engine) confusion[d.actual][d.engine.kind]++;
        return classifyHand(h.decisions, h.adjusted_bb);
    });
    const street_agreement = Object.fromEntries(STREETS.map((s) => [s, { compared: 0, matched: 0 }])) as AgreementReport["street_agreement"];
    let decisions = 0, matched = 0;
    for (const c of classified) {
        decisions += c.compared;
        matched += c.matched;
        for (const s of STREETS) {
            street_agreement[s].compared += c.by_street[s].compared;
            street_agreement[s].matched += c.by_street[s].matched;
        }
    }
    const split = (label: string, include: (c: HandAgreement) => boolean, ok: (c: HandAgreement) => boolean): GroupSplit => {
        const group = classified.filter(include);
        return {
            label,
            matched: summarizeWinrate(group.filter(ok).map((c) => c.result_bb)),
            unmatched: summarizeWinrate(group.filter((c) => !ok(c)).map((c) => c.result_bb))
        };
    };
    const onStreet = (s: AgreementStreet) => (c: HandAgreement) => c.by_street[s].compared > 0;
    const streetOk = (s: AgreementStreet) => (c: HandAgreement) => c.by_street[s].matched === c.by_street[s].compared;
    const postflop = (c: HandAgreement) => STREETS.slice(1).reduce((n, s) => n + c.by_street[s].compared, 0) > 0;
    const postflopOk = (c: HandAgreement) => STREETS.slice(1).every((s) => streetOk(s)(c));
    return {
        hands: hands.length,
        no_decision: classified.filter((c) => c.compared === 0).length,
        decisions,
        decision_agreement: decisions ? matched / decisions : 0,
        street_agreement,
        confusion,
        overall: summarizeWinrate(classified.map((c) => c.result_bb)),
        splits: [
            split("Whole hand (every decision)", (c) => c.compared > 0, (c) => c.all_matched),
            split("Preflop decisions", onStreet("preflop"), streetOk("preflop")),
            split("Post-flop decisions (flop, turn, river)", postflop, postflopOk),
            ...STREETS.slice(1).map((s) => split(`${s[0].toUpperCase()}${s.slice(1)} decisions`, onStreet(s), streetOk(s)))
        ]
    };
}
