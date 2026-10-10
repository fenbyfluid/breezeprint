import test from "node:test";
import assert from "node:assert/strict";
import { identify, loadCandidates } from "./codepage-identify.js";

const candidates = loadCandidates();
const rows = [8, 9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf];

// Answers like a printer that really uses `table`
const oracle = (table) => async (question) => {
    const index = question.options.findIndex((option) => option.codepoint === table[question.byte]);
    return index >= 0 ? index : "other";
};

test("identify finds every codepage from its own upper half", async () => {
    for (const [name, table] of candidates) {
        const matches = await identify(candidates, rows, oracle(table));
        assert.ok(matches.includes(name), `${name} not in [${matches}]`);
    }
});

test("identify tolerates unreadable positions", async () => {
    const table = candidates.get("windows1252");
    let skipNext = true;
    const matches = await identify(candidates, rows, async (question) => {
        if (skipNext) {
            skipNext = false;
            return "skip";
        }
        return oracle(table)(question);
    });
    assert.ok(matches.includes("windows1252"));
});

test("identify never matches more than one codepage for unmatchable answers", async () => {
    const matches = await identify(candidates, rows, async (question) => (question.hasOther ? "other" : 0));
    assert.ok(matches.length <= 1);
});

test("identify confirms a single match with extra questions", async () => {
    const table = candidates.get("cp850");
    let confirmations = 0;
    const matches = await identify(candidates, rows, async (question) => {
        if (question.confirm) {
            ++confirmations;
        }
        return oracle(table)(question);
    });
    assert.deepEqual(matches, ["cp850"]);
    assert.ok(confirmations >= 1);
});

test("identify rejects a match that fails confirmation", async () => {
    const table = candidates.get("cp850");
    const matches = await identify(candidates, rows, async (question) => (question.confirm ? "other" : oracle(table)(question)));
    assert.deepEqual(matches, []);
});
