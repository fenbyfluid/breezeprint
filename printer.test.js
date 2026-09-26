import assert from "node:assert/strict";
import test from "node:test";
import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { renderItem } from "./printer.js";

const item = { source: "telegram", from: "user", timestamp: 1720000000 };

async function receipt(text, from = item.from) {
    const encoder = new ReceiptPrinterEncoder({ columns: 48, imageMode: "column", feedBeforeCut: 0, feedAfterBlock: false, newline: "\n" });
    encoder.initialize();
    await renderItem(encoder, { ...item, text, from });
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

test("defines each distinct emoji grapheme once per line and restores ordinary text", async () => {
    const bytes = await receipt("Go 👍👍 👩‍💻 👩‍💻 🇬🇧 1️⃣ done");
    const selected = Buffer.from([0x1b, 0x25, 1]);
    const standard = Buffer.from([0x1b, 0x25, 0]);
    assert.equal(countCommands(bytes, [0x1b, 0x26, 3]), 4);
    assert.equal(countCommands(bytes, selected), 6);
    assert.equal(countCommands(bytes, standard), 6);
    assert.ok(bytes.indexOf(Buffer.from("done"), bytes.lastIndexOf(standard)) > 0);
});

test("wraps after a 41-column word containing emoji, then redefines on the next line", async () => {
    const bytes = await receipt(`${"a".repeat(39)}👍ok\nagain 👍`);
    const definition = Buffer.from([0x1b, 0x26, 3, 0x21, 0x22]);
    const first = bytes.indexOf(definition);
    const second = bytes.indexOf(definition, first + definition.length);
    const firstLineEnd = bytes.indexOf(0x0a, first);

    assert.ok(first >= 0 && first < firstLineEnd && firstLineEnd < second);
    assert.ok(bytes.indexOf(Buffer.from("ok"), firstLineEnd) > firstLineEnd);
    assert.ok(bytes.indexOf(Buffer.from("again"), firstLineEnd) > firstLineEnd);
});

test("right-aligns the source after a wide emoji in the sender name", async () => {
    for (const [name, spaces] of [[`${"a".repeat(36)}👍`, 1], [`${"a".repeat(37)}👩‍💻`, 0]]) {
        const bytes = await receipt("Hello", name);
        const trailer = bytes.lastIndexOf(Buffer.from("@"));
        const selected = bytes.indexOf(Buffer.from([0x1b, 0x25, 1]), trailer);
        const standard = bytes.indexOf(Buffer.from([0x1b, 0x25, 0]), selected);
        const source = bytes.indexOf(Buffer.from("Telegram"), standard);
        assert.ok(trailer >= 0 && trailer < selected && selected < standard && standard < source);
        assert.equal(bytes.subarray(standard + 3, source).filter((byte) => byte === 0x20).length, spaces);
    }
});