// Prints a configurable range of rows (default 8-F, i.e. 0x80-0xFF) of every ESC/POS code page slot so the printer's real table-to-slot mapping can be read off the paper.
// Usage: node tools/print-codepages.js [--device /dev/usb/lp0] [--from 0] [--to 48] [--min-row 8] [--max-row f] [--dump out.bin]
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";

const { values } = parseArgs({
    options: {
        device: { type: "string", default: process.env.PRINTER_DEVICE_PATH },
        from: { type: "string", default: "0" },
        to: { type: "string", default: "48" },
        "min-row": { type: "string", default: "8" },
        "max-row": { type: "string", default: "f" },
        dump: { type: "string" },
    },
});

const from = Number(values.from);
const to = Number(values.to);
if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 255 || from > to) {
    throw new Error("--from/--to must be integers in 0-255 with from <= to");
}

const minRow = parseInt(values["min-row"], 16);
const maxRow = parseInt(values["max-row"], 16);
// Rows 0 and 1 are control bytes
if (!(minRow >= 2 && maxRow <= 0xf && minRow <= maxRow)) {
    throw new Error("--min-row/--max-row must be hex digits in 2-f with min <= max");
}

const ESC = 0x1b;
const FS = 0x1c;
const LF = 0x0a;

const chunks = [];
const raw = (...bytes) => chunks.push(Buffer.from(bytes));
const ascii = (text) => chunks.push(Buffer.from(text, "latin1"));

raw(ESC, 0x40); // initialize
raw(FS, 0x2e); // cancel Kanji mode so high bytes are never paired as double-byte characters
raw(ESC, 0x4d, 0x00); // font A
raw(ESC, 0x52, 0x00); // international character set: USA

ascii("Code page discovery\n");
ascii(`ESC t ${from}..${to}\n`);
ascii("Pages that look identical to the previous\none are probably unsupported.\n\n");

for (let page = from; page <= to; ++page) {
    ascii(`${"=".repeat(48)}\n`);
    ascii(`ESC t ${page} (0x${page.toString(16).padStart(2, "0")})\n`);
    raw(ESC, 0x74, page);

    // Each byte is separated by a space so a stray lead byte can't swallow its neighbour
    ascii("    0 1 2 3 4 5 6 7 8 9 A B C D E F\n");
    for (let high = minRow; high <= maxRow; ++high) {
        ascii(` ${high.toString(16).toUpperCase()}_ `);
        for (let low = 0; low < 16; ++low) {
            raw((high << 4) | low, 0x20);
        }
        raw(LF);
    }

    raw(ESC, 0x74, 0); // back to page 0 for the ASCII labels
    ascii("\n");
}

ascii("\n\n\n");
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
