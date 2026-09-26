import assert from "node:assert/strict";
import test from "node:test";
import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { ReceiptPrinterRenderer, stitch } from "@point-of-sale/receipt-printer-renderer";
import sharp from "sharp";
import { CustomCharacters } from "./custom-characters.js";

function createEncoder() {
    const encoder = new ReceiptPrinterEncoder({ columns: 48, newline: "\n" });
    encoder.initialize();
    return encoder;
}

async function canvas(width, dots = []) {
    const data = Buffer.alloc(width * 24 * 4, 255);
    for (const [column, row] of dots) {
        const offset = (row * width + column) * 4;
        data.fill(0, offset, offset + 3);
    }
    return sharp(data, { raw: { width, height: 24, channels: 4 } })
        .raw().ensureAlpha().toBuffer({ resolveWithObject: true });
}

function pixel(bitmap, column, row) {
    const stride = (bitmap.width + 7) >> 3;
    return Boolean(bitmap.data[row * stride + (column >> 3)] & (0x80 >> (column & 7)));
}

test("defines adjacent glyphs and renders dots in their respective cells", async () => {
    const encoder = createEncoder();
    const characters = new CustomCharacters(encoder);
    const dots = [[0, 0], [12, 8], [35, 23]];
    assert.equal(characters.define("icon", await canvas(36, dots)), 3);
    encoder.text("X");
    assert.equal(characters.print("icon"), 3);
    encoder.text("!");
    encoder.newline();

    const renderer = new ReceiptPrinterRenderer({
        language: encoder.language,
        width: encoder.printableWidth,
        commands: [],
        capabilities: encoder.printerCapabilities,
    });
    const paper = stitch(renderer.render(encoder.encode()));
    for (const [column, row] of dots) {
        assert.ok(pixel(paper, 12 + column, row), `missing dot at ${column}, ${row}`);
    }
    assert.ok(!pixel(paper, 13, 0));
    assert.ok(!pixel(paper, 24, 0));
});

test("auto-centers the inked pixels within the canvas", async () => {
    const encoder = createEncoder();
    const characters = new CustomCharacters(encoder);
    const dots = [[8, 18], [9, 18], [8, 19], [9, 19]];
    characters.define("icon", await canvas(12, dots), { autoCenter: true });
    characters.print("icon");
    encoder.newline();

    const renderer = new ReceiptPrinterRenderer({
        language: encoder.language,
        width: encoder.printableWidth,
        commands: [],
        capabilities: encoder.printerCapabilities,
    });
    const paper = stitch(renderer.render(encoder.encode()));
    const inked = [];
    for (let row = 0; row < 24; row++) {
        for (let column = 0; column < 12; column++) {
            if (pixel(paper, column, row)) inked.push([column, row]);
        }
    }

    const columns = inked.map(([column]) => column);
    const rows = inked.map(([, row]) => row);
    const left = Math.min(...columns);
    const top = Math.min(...rows);
    assert.deepEqual([left, Math.max(...columns)], [5, 6]);
    assert.deepEqual([top, Math.max(...rows)], [10, 11]);
    assert.deepEqual(inked, dots.map(([column, row]) => [column - 3, row - 8]));
});

test("reusing a key switches glyphs on only while printing its ASCII code", async () => {
    const encoder = createEncoder();
    encoder.codepage("auto");
    const characters = new CustomCharacters(encoder);
    characters.define("icon", await canvas(12));
    encoder.text("A");
    characters.print("icon");
    encoder.text("!");
    characters.print("icon");
    encoder.text("B");
    encoder.newline();

    const bytes = Buffer.from(encoder.encode());
    const definition = Buffer.from([0x1b, 0x26, 3, 0x21, 0x21]);
    const selected = Buffer.from([0x1b, 0x25, 1]);
    const standard = Buffer.from([0x1b, 0x25, 0]);
    const first = bytes.indexOf(selected);
    const firstEnd = bytes.indexOf(standard, first);
    const second = bytes.indexOf(selected, firstEnd + standard.length);
    const secondEnd = bytes.indexOf(standard, second);

    assert.ok(bytes.indexOf(definition) >= 0);
    assert.equal(bytes.indexOf(definition, bytes.indexOf(definition) + definition.length), -1);
    assert.ok(first >= 0 && firstEnd > first && second > firstEnd && secondEnd > second);
    assert.ok(bytes.subarray(first + selected.length, firstEnd).includes(0x21));
    assert.ok(bytes.subarray(second + selected.length, secondEnd).includes(0x21));
    assert.ok(bytes.subarray(firstEnd + standard.length, second).includes(0x21));
    assert.ok(bytes.subarray(secondEnd + standard.length).includes(0x42));
});

test("rejects malformed raw input without reserving a code", async () => {
    const encoder = createEncoder();
    const characters = new CustomCharacters(encoder);
    const image = await canvas(12);
    assert.throws(() => characters.define("icon", { ...image, info: { ...image.info, width: 13 } }), /12\*N/);
    for (const malformed of [
        { ...image, info: { ...image.info, channels: 3 } },
        { ...image, info: { ...image.info, depth: "ushort" } },
        { ...image, data: image.data.subarray(0, -1) },
    ]) {
        assert.throws(() => characters.define("icon", malformed), /raw 8-bit RGBA/);
    }
    assert.equal(characters.has("icon"), false);
    characters.define("icon", image);
    assert.deepEqual([...characters.bytes("icon")], [0x1b, 0x25, 1, 0x21, 0x1b, 0x25, 0]);
    assert.throws(() => characters.define("icon", image), /already defined/);
});

test("slot exhaustion leaves existing keys intact", async () => {
    const characters = new CustomCharacters(createEncoder());
    characters.define("full", await canvas(12 * 94));
    const overflow = await canvas(12);
    assert.throws(() => characters.define("overflow", overflow), /No printable custom character slots/);
    assert.equal(characters.has("overflow"), false);
    assert.equal(characters.width("full"), 94);
    assert.throws(() => characters.print("full"), /printable line width/);
});