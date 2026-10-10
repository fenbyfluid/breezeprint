import assert from "node:assert/strict";
import test from "node:test";
import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { ReceiptPrinterRenderer, stitch } from "@point-of-sale/receipt-printer-renderer";
import sharp from "sharp";
import { CustomCharacters, FIRST_CODE } from "./custom-characters.js";

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
    encoder.text("X");
    assert.equal(characters.print(await canvas(36, dots)), 3);
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
    characters.print(await canvas(12, dots), { autoCenter: true });
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

test("each print defines the next codes and switches glyphs on only while printing them", async () => {
    const encoder = createEncoder();
    encoder.codepage("auto");
    const characters = new CustomCharacters(encoder);
    const image = await canvas(12);
    const other = await canvas(12, [[1, 1]]);
    encoder.text("A");
    characters.print(image);
    encoder.text("!");
    characters.print(other);
    encoder.text("B");
    encoder.newline();

    const bytes = Buffer.from(encoder.encode());
    const selected = Buffer.from([0x1b, 0x25, 1]);
    const standard = Buffer.from([0x1b, 0x25, 0]);
    const first = bytes.indexOf(selected);
    const firstEnd = bytes.indexOf(standard, first);
    const second = bytes.indexOf(selected, firstEnd + standard.length);
    const secondEnd = bytes.indexOf(standard, second);

    assert.ok(bytes.indexOf(Buffer.from([0x1b, 0x26, 3, FIRST_CODE, FIRST_CODE])) >= 0);
    assert.ok(bytes.indexOf(Buffer.from([0x1b, 0x26, 3, FIRST_CODE + 1, FIRST_CODE + 1])) >= 0);
    assert.ok(first >= 0 && firstEnd > first && second > firstEnd && secondEnd > second);
    assert.ok(bytes.subarray(first + selected.length, firstEnd).includes(FIRST_CODE));
    assert.ok(bytes.subarray(second + selected.length, secondEnd).includes(FIRST_CODE + 1));
    assert.ok(bytes.subarray(firstEnd + standard.length, second).includes(0x21));
    assert.ok(bytes.subarray(secondEnd + standard.length).includes(0x42));
});

test("does not modify the source image when dithering", async () => {
    const image = await sharp(Buffer.alloc(12 * 24 * 4, 128), { raw: { width: 12, height: 24, channels: 4 } })
        .raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const before = Buffer.from(image.data);
    new CustomCharacters(createEncoder()).print(image, { algorithm: "atkinson", autoCenter: true });
    assert.deepEqual(image.data, before);
});

test("rejects malformed raw input without reserving a code", async () => {
    const encoder = createEncoder();
    const characters = new CustomCharacters(encoder);
    const image = await canvas(12);
    assert.throws(() => characters.print({ ...image, info: { ...image.info, width: 13 } }), /12\*N/);
    for (const malformed of [
        { ...image, info: { ...image.info, channels: 3 } },
        { ...image, info: { ...image.info, depth: "ushort" } },
        { ...image, data: image.data.subarray(0, -1) },
    ]) {
        assert.throws(() => characters.print(malformed), /raw 8-bit RGBA/);
    }
    assert.equal(CustomCharacters.columns(image), 1);
    characters.print(image);
    assert.ok(Buffer.from(encoder.encode()).indexOf(Buffer.from([0x1b, 0x26, 3, FIRST_CODE, FIRST_CODE])) >= 0);
});

test("rejects glyphs wider than the line or beyond the remaining slots", async () => {
    const tooWide = await canvas(12 * 49);
    assert.throws(() => new CustomCharacters(createEncoder()).print(tooWide), /printable line width/);
    const characters = new CustomCharacters(createEncoder());
    const full = await canvas(12 * 36);
    characters.print(full);
    assert.throws(() => characters.print(full), /No printable custom character slots/);
});