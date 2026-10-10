// Prints code page tables in the terminal to compare against the sheet from print-codepages.js.
// Usage:
//   node tools/show-codepages.js cp866 windows1251          grids of the named tables
//   node tools/show-codepages.js --diff cp866 bixolon/cp866 only the bytes where two tables differ
//   node tools/show-codepages.js --near cp866               other tables ranked by how few bytes differ
//   node tools/show-codepages.js --slot 7                   tables ranked against the answers recorded for a slot
// Options: [--min-row 8] [--max-row f] [--codepoints] [--map codepage-map.json]
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { BLANK, formatTable, loadCandidates, rankCandidates, renderGlyph } from "./codepage-identify.js";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        diff: { type: "boolean", default: false },
        near: { type: "string" },
        slot: { type: "string" },
        "min-row": { type: "string", default: "8" },
        "max-row": { type: "string", default: "f" },
        codepoints: { type: "boolean", default: false },
        map: { type: "string", default: "codepage-map.json" },
    },
});

const minRow = parseInt(values["min-row"], 16);
const maxRow = parseInt(values["max-row"], 16);
if (!(minRow >= 2 && maxRow <= 0xf && minRow <= maxRow)) {
    throw new Error("--min-row/--max-row must be hex digits in 2-f with min <= max");
}
const rows = Array.from({ length: maxRow - minRow + 1 }, (_, i) => minRow + i);
const bytesInRows = rows.flatMap((row) => Array.from({ length: 16 }, (_, column) => (row << 4) | column));

const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, "0");
const describe = (codepoint) => (codepoint === BLANK ? "(blank)" : `${renderGlyph(codepoint)} U+${hex(codepoint, 4)}`);

const candidates = loadCandidates();

function table(name) {
    const found = candidates.get(name);
    if (!found) {
        throw new Error(`Unknown code page "${name}". Known: ${[...candidates.keys()].join(", ")}`);
    }
    return found;
}

if (values.slot !== undefined) {
    const { slots } = JSON.parse(await readFile(values.map, "utf8"));
    const answers = slots[values.slot]?.answers;
    if (!answers?.length) {
        throw new Error(`No recorded answers for slot ${values.slot} in ${values.map} (re-run identify-codepages.js --verify to record them)`);
    }

    console.log(`Slot ${values.slot}: ${answers.length} recorded answers`);
    for (const { name, mismatches } of rankCandidates(candidates, answers).slice(0, 8)) {
        console.log(`\n${name}: ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`);
        for (const byte of mismatches) {
            const answer = answers.find((a) => a.byte === byte);
            const observed = "codepoint" in answer ? describe(answer.codepoint) : `none of ${answer.notOneOf.map(describe).join(" ")}`;
            console.log(`  0x${hex(byte, 2)}: you saw ${observed}; table has ${describe(table(name)[byte])}`);
        }
    }
} else if (values.near !== undefined) {
    const base = table(values.near);
    const ranked = [...candidates]
        .filter(([name]) => name !== values.near)
        .map(([name, other]) => ({ name, differing: bytesInRows.filter((byte) => other[byte] !== base[byte]).length }))
        .sort((a, b) => a.differing - b.differing);

    console.log(`Closest to ${values.near} over ${bytesInRows.length} bytes:`);
    for (const { name, differing } of ranked.slice(0, 10)) {
        console.log(`  ${name}: ${differing} differ`);
    }
} else if (values.diff) {
    if (positionals.length !== 2) {
        throw new Error("--diff needs exactly two code page names");
    }

    const [a, b] = positionals.map(table);
    const differing = bytesInRows.filter((byte) => a[byte] !== b[byte]);
    console.log(`${positionals[0]} vs ${positionals[1]}: ${differing.length} differing bytes`);
    for (const byte of differing) {
        console.log(`  0x${hex(byte, 2)}: ${describe(a[byte])}  |  ${describe(b[byte])}`);
    }
} else if (positionals.length > 0) {
    for (const name of positionals) {
        console.log(`\n${name}`);
        console.log(formatTable(table(name), rows, { codepoints: values.codepoints }));
    }
} else {
    throw new Error("Nothing to show; see the usage at the top of this file");
}
