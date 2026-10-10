// Interactively identifies the code page behind each ESC t slot from the sheet printed by print-codepages.js.
// Usage: node tools/identify-codepages.js [--from 0] [--to 48] [--min-row 8] [--max-row f] [--out codepage-map.json] [--verify]
// Re-running resumes from --out, skipping slots that already have an answer.
// --verify re-checks slots already marked identified, and re-identifies any that fail.
// --redo-unknown re-identifies slots previously marked unknown.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { BLANK, confirm, identify, loadCandidates, rankCandidates, renderGlyph, summarize } from "./codepage-identify.js";

const { values } = parseArgs({
    options: {
        from: { type: "string", default: "0" },
        to: { type: "string", default: "48" },
        "min-row": { type: "string", default: "8" },
        "max-row": { type: "string", default: "f" },
        out: { type: "string", default: "codepage-map.json" },
        verify: { type: "boolean", default: false },
        "redo-unknown": { type: "boolean", default: false },
    },
});

const from = Number(values.from);
const to = Number(values.to);
const minRow = parseInt(values["min-row"], 16);
const maxRow = parseInt(values["max-row"], 16);
if (!(from >= 0 && to <= 255 && from <= to && minRow >= 2 && maxRow <= 0xf && minRow <= maxRow)) {
    throw new Error("Invalid --from/--to (0-255) or --min-row/--max-row (hex digits 2-f)");
}
const rows = Array.from({ length: maxRow - minRow + 1 }, (_, i) => minRow + i);

let slots = {};
try {
    slots = JSON.parse(await readFile(values.out, "utf8")).slots ?? {};
} catch (error) {
    if (error.code !== "ENOENT") {
        throw error;
    }
}

const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, "0");
const glyph = (codepoint) => (codepoint === BLANK ? "(blank)" : `${renderGlyph(codepoint)}   U+${hex(codepoint, 4)}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Per-slot record of what was answered, kept so close matches can be ranked later
let answers = [];

async function save() {
    await writeFile(values.out, JSON.stringify({ slots, ...summarize(slots) }, null, 2) + "\n");
}

async function ask(question, remaining) {
    const choice = await askUser(question, remaining);
    if (choice === "other") {
        answers.push({ byte: question.byte, notOneOf: question.options.map((option) => option.codepoint) });
    } else if (choice !== "skip") {
        answers.push({ byte: question.byte, codepoint: question.options[choice].codepoint });
    }
    return choice;
}

async function askUser(question, remaining) {
    console.log(question.confirm
        ? `\nConfirming ${question.candidate}. Byte 0x${hex(question.byte, 2)} (row ${hex(question.byte >> 4, 1)}, column ${hex(question.byte & 0xf, 1)}) - what is printed there?`
        : `\n${remaining} candidates left. Byte 0x${hex(question.byte, 2)} (row ${hex(question.byte >> 4, 1)}, column ${hex(question.byte & 0xf, 1)}) - what is printed there?`);
    question.options.forEach((option, index) => console.log(`  ${index + 1}) ${glyph(option.codepoint)}`));
    console.log("  o) none of these");
    console.log("  s) can't tell");

    for (;;) {
        const answer = (await rl.question("> ")).trim().toLowerCase();
        if (answer === "s") {
            return "skip";
        }
        if (answer === "o") {
            return "other";
        }
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < question.options.length) {
            return index;
        }
        console.log("Not a valid choice");
    }
}

const candidates = loadCandidates();
let quit = false;

// A code page can only live in one slot, so ones already assigned elsewhere aren't candidates
function availableFor(slot) {
    const taken = new Set(Object.entries(slots).filter(([other, result]) => Number(other) !== slot && result.status === "identified").map(([, result]) => result.codepages[0]));
    return new Map([...candidates].filter(([name]) => !taken.has(name)));
}

const owners = new Map();
for (const [slot, result] of Object.entries(slots)) {
    if (result.status === "identified") {
        owners.set(result.codepages[0], [...(owners.get(result.codepages[0]) ?? []), slot]);
    }
}
for (const [name, owned] of owners) {
    if (owned.length > 1) {
        console.log(`${name} is assigned to slots ${owned.join(", ")}; ${values.verify ? "re-identifying them" : "re-run with --verify to fix"}`);
        if (values.verify) {
            owned.forEach((slot) => delete slots[slot]);
        }
    }
}

for (let slot = from; slot <= to && !quit; ++slot) {
    answers = [];

    if (values["redo-unknown"] && slots[slot]?.status === "unknown") {
        delete slots[slot];
    }

    if (values.verify && slots[slot]?.status === "identified") {
        console.log(`\n=== Verifying slot ${slot} (${slots[slot].codepages[0]}) ===`);
        if (await confirm(candidates, slots[slot].codepages[0], rows, ask)) {
            console.log(`Slot ${slot} confirmed`);
            continue;
        }

        console.log(`Slot ${slot} failed verification, identifying again`);
        delete slots[slot];
    }

    if (slots[slot]) {
        continue;
    }

    for (;;) {
        console.log(`\n=== Slot ${slot} (ESC t ${slot}, 0x${hex(slot, 2)}) ===`);
        const action = (await rl.question("[Enter] identify, b = blank, s = skip/unsupported, q = save and quit: ")).trim().toLowerCase();

        if (action === "q") {
            quit = true;
        } else if (action === "b") {
            slots[slot] = { status: "blank" };
        } else if (action === "s") {
            slots[slot] = { status: "skipped" };
        } else {
            answers = [];
            const available = availableFor(slot);
            const matches = await identify(available, rows, ask);

            if (matches.length === 0) {
                console.log("\nNo known code page matches those answers (either a glyph was misread, or the printer uses a table the library doesn't have).");
                console.log("Closest by your answers:");
                for (const { name, mismatches } of rankCandidates(available, answers).slice(0, 5)) {
                    console.log(`  ${name}: ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}${mismatches.length ? ` at ${mismatches.map((byte) => "0x" + hex(byte, 2)).join(", ")}` : ""}`);
                }

                const retry = (await rl.question("[Enter] retry slot, u = mark unknown, or a code page name above to accept it: ")).trim();
                if (available.has(retry)) {
                    slots[slot] = { status: "identified", codepages: [retry], accepted: "closest", answers };
                } else if (retry.toLowerCase() === "u") {
                    slots[slot] = { status: "unknown", answers };
                } else {
                    continue;
                }
            } else {
                slots[slot] = { status: matches.length === 1 ? "identified" : "ambiguous", codepages: matches, answers };
                console.log(`\nSlot ${slot}: ${matches.join(", ")}${matches.length > 1 ? " (can't be told apart from the printed rows)" : ""}`);
            }
        }

        break;
    }

    await save();
}

rl.close();
await save();

const { codepageMapping, codepageCandidates, ambiguous } = summarize(slots);
console.log(`\nWrote ${values.out}\n`);
console.log("codepageMapping:", JSON.stringify(codepageMapping));
console.log("codepageCandidates:", JSON.stringify(codepageCandidates));
if (Object.keys(ambiguous).length > 0) {
    console.log("Ambiguous slots (not in the mapping):", JSON.stringify(ambiguous));
}
