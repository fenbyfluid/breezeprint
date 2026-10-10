import assert from "node:assert/strict";
import test from "node:test";
import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { renderItem } from "./printer.js";
import { FIRST_CODE, MAX_GLYPHS } from "./custom-characters.js";

const item = { source: "test", from: "user", timestamp: 1720000000 };

async function receipt(text, from = item.from, source = item.source) {
    const encoder = new ReceiptPrinterEncoder({ columns: 48, imageMode: "column", feedBeforeCut: 0, feedAfterBlock: false, newline: "\n" });
    encoder.initialize();
    await renderItem(encoder, { ...item, text, from, source });
    return Buffer.from(encoder.encode());
}

function countCommands(bytes, command) {
    return bytes.toString("latin1").split(Buffer.from(command).toString("latin1")).length - 1;
}

test("preserves plain text and explicit empty lines without downloading glyphs", async () => {
    const bytes = await receipt("Hello world\n\nSecond line");
    assert.equal(countCommands(bytes, [0x1b, 0x26, 3]), 0);
    assert.ok(bytes.indexOf(Buffer.from("Hello world\n\n")) >= 0);
    assert.ok(bytes.indexOf(Buffer.from("Second line")) > bytes.indexOf(Buffer.from("Hello world")));
});

test("defines every emoji grapheme on its line and restores ordinary text", async () => {
    const bytes = await receipt("Go 👍👍 👩‍💻 👩‍💻 🇬🇧 1️⃣ done");
    const selected = Buffer.from([0x1b, 0x25, 1]);
    const standard = Buffer.from([0x1b, 0x25, 0]);
    assert.equal(countCommands(bytes, [0x1b, 0x26, 3]), 12);
    assert.equal(countCommands(bytes, selected), 6);
    assert.equal(countCommands(bytes, standard), 6);
    assert.ok(bytes.indexOf(Buffer.from("done"), bytes.lastIndexOf(standard)) > 0);
});

test("wraps long emoji runs so no line defines more glyphs than the printer supports", async () => {
    const bytes = await receipt(`${"⬛".repeat(20)} x`);
    const perLine = [];
    let glyphs = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x1b && bytes[i + 1] === 0x26 && bytes[i + 2] === 3) {
            glyphs++;
            i += 5 + 1 + 36 - 1; // command header, width byte and 12 columns of 3 bytes, less the loop's own increment
        } else if (bytes[i] === 0x0a && glyphs) {
            perLine.push(glyphs);
            glyphs = 0;
        }
    }
    if (glyphs) perLine.push(glyphs);

    // Body lines (20 emoji is 40 glyphs) plus the footer line
    assert.ok(perLine.length >= 2);
    assert.ok(perLine.every((count) => count <= MAX_GLYPHS), `glyphs per line: ${perLine}`);
    assert.equal(perLine.reduce((sum, count) => sum + count, 0), 40);
});

test("wraps after a 41-column word containing emoji, then redefines from the first code on the next line", async () => {
    const bytes = await receipt(`${"a".repeat(39)}👍ok\nagain 👍`);
    const definition = Buffer.from([0x1b, 0x26, 3, FIRST_CODE, FIRST_CODE]);
    const first = bytes.indexOf(definition);
    const second = bytes.indexOf(definition, first + definition.length);
    const firstLineEnd = bytes.indexOf(0x0a, first);

    assert.equal(countCommands(bytes, [0x1b, 0x26, 3]), 4);
    assert.ok(first >= 0 && first < firstLineEnd && firstLineEnd < second);
    assert.ok(bytes.indexOf(Buffer.from("ok"), firstLineEnd) > firstLineEnd);
    assert.ok(bytes.indexOf(Buffer.from("again"), firstLineEnd) > firstLineEnd);
});

test("uses two custom characters and a two-column gap for overflowing sender names", async () => {
    for (const name of [`${"a".repeat(42)}👍`, `${"a".repeat(42)}👩‍💻`, "a".repeat(60)]) {
        const bytes = await receipt("Hello", name);
        const definition = Buffer.from([0x1b, 0x26, 3, FIRST_CODE, FIRST_CODE]);
        const selectCustom = Buffer.from([0x1b, 0x25, 1]);
        const selectStandard = Buffer.from([0x1b, 0x25, 0]);
        const definitionIndex = bytes.indexOf(definition);
        const customIndex = bytes.indexOf(selectCustom, definitionIndex);
        const standardIndex = bytes.indexOf(selectStandard, customIndex + selectCustom.length);
        const source = bytes.indexOf(Buffer.from("test"), standardIndex);
        assert.ok(definitionIndex >= 0);
        assert.ok(customIndex > definitionIndex && standardIndex > customIndex && standardIndex < source);
        assert.equal(standardIndex - (customIndex + 6), 2);
        assert.equal(bytes.subarray(standardIndex, source).filter((byte) => byte === 0x20).length, 2);
    }
});