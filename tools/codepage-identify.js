import CodepageEncoder from "@point-of-sale/codepage-encoder";

export const BLANK = 0;
export const MAX_OPTIONS = 8;

// Anything that prints as nothing is indistinguishable on paper
const normalize = (codepoint) => (codepoint === 0 || codepoint === 0x20 || codepoint === 0xa0 || (codepoint >= 0x7f && codepoint < 0xa0) ? BLANK : codepoint);

/** @returns {Map<string, number[]>} codepage name -> 256 normalized codepoints indexed by byte */
export function loadCandidates() {
    const candidates = new Map();
    for (const name of CodepageEncoder.getEncodings()) {
        if (name === "ascii") {
            continue;
        }
        candidates.set(name, CodepageEncoder.getCodepoints(name, true).map(normalize));
    }
    return candidates;
}

/**
 * Picks the byte whose printed glyph best splits the candidates.
 * Only the largest groups are offered as options; the rest are lumped into "other".
 * @param {Map<string, number[]>} candidates
 * @param {Iterable<number>} rows high nibbles of the rows that were printed
 * @param {Set<number>} skipped bytes the user couldn't read
 */
export function nextQuestion(candidates, rows, skipped = new Set()) {
    let best = null;

    for (const row of rows) {
        for (let column = 0; column < 16; ++column) {
            const byte = (row << 4) | column;
            if (skipped.has(byte)) {
                continue;
            }

            const groups = new Map();
            for (const [name, table] of candidates) {
                const names = groups.get(table[byte]);
                if (names) {
                    names.push(name);
                } else {
                    groups.set(table[byte], [name]);
                }
            }

            if (groups.size < 2) {
                continue;
            }

            const sorted = [...groups].map(([codepoint, names]) => ({ codepoint, names })).sort((a, b) => b.names.length - a.names.length);
            const options = sorted.slice(0, MAX_OPTIONS);
            const otherSize = sorted.slice(MAX_OPTIONS).reduce((sum, group) => sum + group.names.length, 0);

            // Expected number of candidates left after answering (lower is better)
            const score = options.reduce((sum, option) => sum + option.names.length ** 2, otherSize ** 2);
            if (!best || score < best.score) {
                best = { byte, options, hasOther: otherSize > 0, score };
            }
        }
    }

    return best && { byte: best.byte, options: best.options, hasOther: best.hasOther };
}

/** @param {number | "other"} choice index into question.options, or "other" for none of them */
export function applyAnswer(candidates, question, choice) {
    const shown = new Set(question.options.flatMap((option) => option.names));
    const keep = choice === "other" ? (name) => !shown.has(name) : (name) => question.options[choice].names.includes(name);

    return new Map([...candidates].filter(([name]) => keep(name)));
}

/**
 * Asks about a byte the matched table has a rare glyph for, so a table the library doesn't know is unlikely to pass by chance.
 * @param {Set<number>} excluded bytes already asked
 */
export function confirmationQuestion(candidates, name, rows, excluded) {
    const table = candidates.get(name);
    let best = null;

    for (const row of rows) {
        for (let column = 0; column < 16; ++column) {
            const byte = (row << 4) | column;
            if (excluded.has(byte) || table[byte] === BLANK) {
                continue;
            }

            let sharedBy = 0;
            for (const other of candidates.values()) {
                if (other[byte] === table[byte]) {
                    ++sharedBy;
                }
            }

            if (!best || sharedBy < best.sharedBy) {
                best = { byte, sharedBy };
            }
        }
    }

    if (!best) {
        return null;
    }

    const groups = new Map();
    for (const [candidate, other] of candidates) {
        const names = groups.get(other[best.byte]);
        if (names) {
            names.push(candidate);
        } else {
            groups.set(other[best.byte], [candidate]);
        }
    }

    const expected = table[best.byte];
    const sorted = [...groups].map(([codepoint, names]) => ({ codepoint, names })).sort((a, b) => b.names.length - a.names.length);
    const options = sorted.slice(0, MAX_OPTIONS);
    if (!options.some((option) => option.codepoint === expected)) {
        options[options.length - 1] = sorted.find((option) => option.codepoint === expected);
    }

    return { byte: best.byte, options, hasOther: true, confirm: true, candidate: name, expected };
}

/**
 * @param {(question: ReturnType<typeof nextQuestion>, remaining: number) => Promise<number | "other" | "skip">} ask
 * @param {number} confirmations extra questions asked about a single match before trusting it
 * @returns names still matching; one is a confident match, several means the printed rows can't tell them apart, none means inconsistent answers or an unknown table
 */
export async function identify(candidates, rows, ask, { confirmations = 2 } = {}) {
    const asked = new Set();
    const skipped = new Set();
    let remaining = candidates;

    while (remaining.size > 1) {
        const question = nextQuestion(remaining, rows, skipped);
        if (!question) {
            break;
        }

        asked.add(question.byte);
        const choice = await ask(question, remaining.size);
        if (choice === "skip") {
            skipped.add(question.byte);
            continue;
        }

        remaining = applyAnswer(remaining, question, choice);
    }

    if (remaining.size === 1) {
        const [name] = remaining.keys();
        if (!(await confirm(candidates, name, rows, ask, { confirmations, asked }))) {
            return [];
        }
    }

    return [...remaining.keys()];
}

/**
 * Asks extra questions to check that a codepage really matches
 * @param {Set<number>} asked bytes to avoid because they were already answered
 */
export async function confirm(candidates, name, rows, ask, { confirmations = 2, asked = new Set() } = {}) {
    for (let confirmed = 0; confirmed < confirmations; ) {
        const question = confirmationQuestion(candidates, name, rows, asked);
        if (!question) {
            break;
        }

        asked.add(question.byte);
        const choice = await ask(question, 1);
        if (choice === "skip") {
            continue;
        }

        if (choice === "other" || question.options[choice].codepoint !== question.expected) {
            return false;
        }
        ++confirmed;
    }

    return true;
}

/**
 * Ranks candidates by how few recorded answers they contradict.
 * @param {({ byte: number, codepoint: number } | { byte: number, notOneOf: number[] })[]} answers
 * @returns {{ name: string, mismatches: number[] }[]} bytes each candidate disagrees on, best first
 */
export function rankCandidates(candidates, answers) {
    return [...candidates]
        .map(([name, table]) => ({
            name,
            mismatches: answers
                .filter((answer) => ("codepoint" in answer ? table[answer.byte] !== answer.codepoint : answer.notOneOf.includes(table[answer.byte])))
                .map((answer) => answer.byte),
        }))
        .sort((a, b) => a.mismatches.length - b.mismatches.length);
}

/** Isolated so right-to-left scripts don't reorder neighbours; combining marks get a base so they're visible */
export function renderGlyph(codepoint) {
    if (codepoint === BLANK) {
        return "\u00b7";
    }

    const char = String.fromCodePoint(codepoint);
    return `\u2066${/\p{M}/u.test(char) ? "\u25cc" : ""}${char}\u2069`;
}

/** A 16-column grid like the printed sheet */
export function formatTable(table, rows, { codepoints = false } = {}) {
    const cell = (byte) => (codepoints ? (table[byte] === BLANK ? "-" : table[byte].toString(16).toUpperCase()).padEnd(5) : `${renderGlyph(table[byte])}  `);
    const lines = [`     ${Array.from({ length: 16 }, (_, column) => column.toString(16).toUpperCase().padEnd(codepoints ? 5 : 3)).join("")}`];

    for (const row of rows) {
        lines.push(` ${row.toString(16).toUpperCase()}_  ${Array.from({ length: 16 }, (_, column) => cell((row << 4) | column)).join("")}`);
    }

    return lines.join("\n");
}

/** Turns per-slot results into encoder options */
export function summarize(slots) {
    const mapping = {};
    const ambiguous = {};

    for (const [slot, result] of Object.entries(slots)) {
        if (result.codepages?.length === 1) {
            mapping[result.codepages[0]] = Number(slot);
        } else if (result.codepages?.length > 1) {
            ambiguous[slot] = result.codepages;
        }
    }

    return { codepageMapping: mapping, codepageCandidates: Object.keys(mapping), ambiguous };
}
