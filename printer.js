import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { ReceiptPrinterRenderer, stitch, toPng } from "@point-of-sale/receipt-printer-renderer";
import { SerialPort } from "serialport";
import sharp from "sharp";
import { CustomCharacters } from "./custom-characters.js";

// Render a run of only emoji (and joiners/variation selectors) as an image
const EMOJI_ONLY_REGEX = /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\p{Zs}\t]+$/u;
const INLINE_EMOJI_REGEX = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function centerImage(image, printableWidth) {
    if (image.info.width >= printableWidth) {
        return image;
    }

    const leftPad = Math.floor((printableWidth - image.info.width) / 2);
    const rightPad = printableWidth - image.info.width - leftPad;

    return sharp(image.data, { raw: image.info })
        .extend({ left: leftPad, right: rightPad, background: "white" })
        .raw().ensureAlpha().toBuffer({ resolveWithObject: true });
}

/**
 * @param {ReceiptPrinterEncoder} encoder 
 * @param {{ text?: string, image?: Buffer, source: string, from: string, timestamp: number }} item 
 */
export async function renderItem(encoder, item) {
    const itemTimestamp = new Date(item.timestamp * 1000);
    const timeLabel = [
        String(itemTimestamp.getHours()).padStart(2, '0'),
        String(itemTimestamp.getMinutes()).padStart(2, '0')
    ].join(":");
    const dateLabel = [
        String(itemTimestamp.getDate()).padStart(2, '0'),
        String(itemTimestamp.getMonth() + 1).padStart(2, '0'),
        String(itemTimestamp.getFullYear() - 2000).padStart(2, '0')
    ].join("/");

    // Header
    encoder.newline();
    encoder.line(alignLeftRightLine(timeLabel, dateLabel, encoder.columns));
    encoder.rule();
    encoder.newline();
    
    // Body
    encoder.codepage("auto");
    const maxBodyPct = 0.85;
    if (!item.image && !item.text) {
        throw new Error("Item has no image data or text");
    }

    if (item.image) {
        // Shrink to fit the printable width, never enlarge
        // encoder.image() assumes 4 bytes (RGBA) per pixel, so force an alpha channel here
        const resized = await sharp(item.image, { autoOrient: true })
            .trim({ lineArt: true })
            .resize({ width: Math.floor(encoder.printableWidth * maxBodyPct), withoutEnlargement: true })
            .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

        // Pad the shrunk image back up to the printable width, centering it
        const image = await centerImage(resized, encoder.printableWidth);

        encoder.image(image, { algorithm: "atkinson" });
    }

    if (item.text) {
        if (EMOJI_ONLY_REGEX.test(item.text)) {
            const spacer = process.platform === "darwin" ? "\u2002" : ""; // Apple Emoji needs some more space
            const emojiText = item.text.replace(/\s/gu, "");
            const renderSize = Math.floor(encoder.printableWidth * maxBodyPct);
            const spaced = Array.from(GRAPHEME_SEGMENTER.segment(emojiText), ({ segment }) => segment).join(spacer);
            const rendered = await sharp({ text: { text: spaced, width: renderSize, height: renderSize, wrap: "none", rgba: true } })
                .trim({ lineArt: true })
                .resize(renderSize, renderSize, { fit: "inside", background: "white" })
                .flatten({ background: "white" })
                .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

            const image = await centerImage(rendered, encoder.printableWidth);

            encoder.image(image, { algorithm: "atkinson" });
        } else {
            const maxTextColumns = Math.ceil(encoder.columns * 0.85);
            const { lines, wrapped } = wrapText(item.text, maxTextColumns);
            
            if (item.image || lines.length < 3) {
                encoder.newline();
            }

            if (!wrapped) {
                encoder.align("center");
                for (const line of lines) {
                    await renderLineWithEmoji(encoder, line);
                }
                encoder.align("left");
            } else {
                const leftPadding = Math.floor((encoder.columns - maxTextColumns) / 2);
                for (const line of lines) {
                    await renderLineWithEmoji(encoder, `${" ".repeat(leftPadding)}${line}`);
                }
            }

            if (!item.image && lines.length < 3) {
                encoder.newline();
            }
        }
    }

    // Trailer
    encoder.newline();
    encoder.rule();
    await renderItemTrailer(encoder, item);
}

async function renderItemTrailer(encoder, item) {
    // TODO: Would like to display these as a small logo instead
    const knownSources = {
        meshcore: { label: "MeshCore" },
        telegram: { label: "Telegram", prefix: "@" },
    };
    
    const sourceInfo = knownSources[item.source] || { label: item.source };
    const fromLabel = `${sourceInfo.prefix || ""}${item.from}`;
    const sourceLabel = sourceInfo.label;
    
    await renderLineWithEmoji(encoder, alignLeftRightLine(fromLabel, sourceLabel, encoder.columns));
}

function alignLeftRightLine(left, right, width) {
    return `${left}${" ".repeat(width - textWidth(left) - textWidth(right))}${right}`;
}

function characterWidth(segment) {
    return INLINE_EMOJI_REGEX.test(segment) ? 2 : 1;
}

function textWidth(text) {
    return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment)
        .reduce((columns, segment) => columns + characterWidth(segment), 0);
}

function wrapText(text, width) {
    const lines = [];
    let wrapped = false;

    for (const paragraph of text.split(/\r?\n/u)) {
        let line = "";
        let columns = 0;

        for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) {
            const characters = Array.from(GRAPHEME_SEGMENTER.segment(word), ({ segment }) => segment);
            const wordWidth = characters.reduce((sum, segment) => sum + characterWidth(segment), 0);
            if (columns && columns + 1 + wordWidth > width) {
                wrapped = true;
                lines.push(line);
                line = "";
                columns = 0;
            }

            if (columns) {
                line += " ";
                columns++;
            }
            for (const segment of characters) {
                const size = characterWidth(segment);
                if (columns + size > width) {
                    wrapped = true;
                    lines.push(line);
                    line = "";
                    columns = 0;
                }
                line += segment;
                columns += size;
            }
        }

        lines.push(line);
    }

    return { lines, wrapped };
}

async function renderLineWithEmoji(encoder, line) {
    const characters = new CustomCharacters(encoder);
    let plain = "";

    for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
        if (!INLINE_EMOJI_REGEX.test(segment)) {
            plain += segment;
            continue;
        }

        if (plain) {
            encoder.text(plain);
            plain = "";
        }

        if (!characters.has(segment)) {
            try {
                const renderSize = 24;
                const image = await sharp({ text: { text: segment, width: renderSize, height: renderSize, wrap: "none", rgba: true } })
                    .trim({ lineArt: true })
                    .resize(renderSize, renderSize, { fit: "contain", background: "white" })
                    .flatten({ background: "white" })
                    .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

                characters.define(segment, image, { algorithm: "atkinson", autoCenter: true });
            } catch (error) {
                console.error("[printer] Failed to rasterize emoji", segment, error);
            }
        }

        if (characters.has(segment)) {
            characters.print(segment);
        } else {
            encoder.text("??");
        }
    }

    if (plain) {
        encoder.text(plain);
    }

    encoder.newline();
}

async function sendToPrinter(bytes) {
    const path = process.env.PRINTER_SERIAL_PATH;
    if (!path) {
        console.log('[printer] command bytes:', Buffer.from(bytes).toString("hex"));
        return;
    }

    const port = new SerialPort({
        path,
        baudRate: Number(process.env.PRINTER_BAUD_RATE) || 9600,
        autoOpen: false,
    });

    const call = (method, ...args) => new Promise((resolve, reject) => {
        port[method](...args, (error) => (error ? reject(error) : resolve()));
    });

    await call("open");
    try {
        await call("write", Buffer.from(bytes));
        await call("drain");
    } finally {
        await call("close").catch((error) => console.error("[printer] Failed to close serial port", error));
    }
}

// Items can be delivered concurrently, so jobs must not interleave on the port
let printQueue = Promise.resolve();

function queuePrint(bytes) {
    const job = printQueue.then(() => sendToPrinter(bytes));
    printQueue = job.catch(() => {});
    return job;
}

export async function renderReceipt(item) {
    // TODO: Check this against our printer capabilities
    const encoder = new ReceiptPrinterEncoder({
        columns: 48,
        imageMode: "column",
        // We don't want any feed in our rendered images, figure out the real printer later
        feedBeforeCut: 0,
        feedAfterBlock: false,
        newline: "\n",
    });

    encoder.initialize();
    await renderItem(encoder, item);
    encoder.cut('partial');

    const bytes = encoder.encode();

    try {
        await queuePrint(bytes);
    } catch (error) {
        console.error("[printer] Failed to send to printer", error);
    }

    const renderer = new ReceiptPrinterRenderer({
        language: encoder.language,
        width: encoder.printableWidth,
        commands: [],
        capabilities: encoder.printerCapabilities,
    });

    const items = renderer.render(bytes);

    // Combine the rendered items into a single paper bitmap
    const paper = stitch(items);

    // Pad the image from the 72mm printable area to the 80mm paper area
    // 32 pixels of padding each side
    // Quite hacky as receipt-printer-renderer doesn't export its bitmap class
    const padded = { width: paper.width + 64, height: paper.height, data: null };
    padded.data = new Uint8Array(((padded.width + 7) >> 3) * padded.height);
    for (let row = 0; row < paper.height; ++row) {
        const sourceStart = row * ((paper.width + 7) >> 3);
        const paddedStart = row * ((padded.width + 7) >> 3) + 4;
        const sourceRow = paper.data.subarray(sourceStart, sourceStart + ((paper.width + 7) >> 3));
        padded.data.set(sourceRow, paddedStart);
    }

    return await toPng(padded);
}
