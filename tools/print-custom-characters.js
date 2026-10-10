// Defines a 12x24 glyph for every code in a range and prints them, to find how many custom characters a printer supports (FIRST_CODE/LAST_CODE in custom-characters.js).
// Codes the printer ignores print as their plain ASCII character instead of a glyph, so the last glyph before the first letter is the printer's limit.
// The limit depends on glyph content: dense "box" glyphs are the worst case (36 on the current printer), while "blank" glyphs fit about double.
// Definitions the printer rejects may be misread as commands and swallow the output, so narrow --to if the table goes missing.
// Usage: node tools/print-custom-characters.js [--device /dev/usb/lp0] [--from 20] [--to 7e] [--glyph box|blank] [--dump out.bin]
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";

const { values } = parseArgs({
    options: {
        device: { type: "string", default: process.env.PRINTER_DEVICE_PATH },
        from: { type: "string", default: "20" },
        to: { type: "string", default: "7e" },
        glyph: { type: "string", default: "box" },
        dump: { type: "string" },
    },
});

const from = parseInt(values.from, 16);
const to = parseInt(values.to, 16);
// ESC & only addresses the printable ASCII range
if (!(from >= 0x20 && to <= 0x7e && from <= to)) {
    throw new Error("--from/--to must be hex codes in 20-7e with from <= to");
}
if (values.glyph !== "box" && values.glyph !== "blank") {
    throw new Error("--glyph must be box or blank");
}

const ESC = 0x1b;
const LF = 0x0a;
const GLYPH_WIDTH = 12;
const PER_ROW = 16;

const chunks = [];
const raw = (...bytes) => chunks.push(Buffer.from(bytes));
const ascii = (text) => chunks.push(Buffer.from(text, "latin1"));

// Blank prints as a gap, so defined codes show as spaces and ignored ones as letters
const glyph = [];
for (let column = 0; column < GLYPH_WIDTH; column++) {
    if (values.glyph === "blank") glyph.push(0, 0, 0);
    else glyph.push(...(column === 0 || column === GLYPH_WIDTH - 1 ? [0xff, 0xff, 0xff] : [0xc0, 0x00, 0x03]));
}

raw(ESC, 0x40); // initialize
raw(ESC, 0x4d, 0x00); // font A

ascii("Custom character discovery\n");
ascii(`Defining 0x${from.toString(16)}..0x${to.toString(16)} (${to - from + 1} codes), ${values.glyph} glyphs\n`);
ascii("Glyphs are defined codes; plain characters are\ncodes the printer ignored.\n\n");

// One glyph per command, as custom-characters.js does
for (let code = from; code <= to; code++) {
    raw(ESC, 0x26, 3, code, code, GLYPH_WIDTH, ...glyph);
}

for (let start = from; start <= to; start += PER_ROW) {
    ascii(`${start.toString(16).padStart(2, "0")}: `);
    for (let code = start; code < Math.min(start + PER_ROW, to + 1); code++) {
        raw(ESC, 0x25, 1, code, ESC, 0x25, 0, 0x20);
    }
    raw(LF);
}

ascii("\n\n\n\n");
raw(0x1d, 0x56, 0x42, 0x00); // feed and partial cut

const bytes = Buffer.concat(chunks);

if (values.dump) {
    await writeFile(values.dump, bytes);
    console.log(`Wrote ${bytes.length} bytes to ${values.dump}`);
}

if (values.device) {
    await writeFile(values.device, bytes, { flag: "a" });
    console.log(`Sent ${bytes.length} bytes to ${values.device}`);
} else if (!values.dump) {
    throw new Error("No printer configured: pass --device or set PRINTER_DEVICE_PATH (or use --dump)");
}
