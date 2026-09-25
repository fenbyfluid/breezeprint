import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { ReceiptPrinterRenderer, stitch, toPng } from "@point-of-sale/receipt-printer-renderer";
import { SerialPort } from "serialport";
import sharp from "sharp";

// Render a run of only emoji (and joiners/variation selectors) as an image
const EMOJI_ONLY_REGEX = /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\p{Zs}\t]+$/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function centerImage(image, printableWidth) {
    if (image.info.width >= printableWidth) {
        return image;
    }

    const leftPad = Math.floor((printableWidth - image.info.width) / 2);
    const rightPad = printableWidth - image.info.width - leftPad;

    return sharp(image.data, { raw: image.info })
        .extend({ left: leftPad, right: rightPad, background: { r: 255, g: 255, b: 255 } })
        .raw().ensureAlpha().toBuffer({ resolveWithObject: true });
}

/**
 * @param {ReceiptPrinterEncoder} encoder 
 * @param {{ text?: string, image?: Buffer, source: string, from: string, timestamp: number }} item 
 */
async function renderItem(encoder, item) {
    // Header
    const { date, time } = formatTimestamp(item.timestamp);
    encoder.newline();
    encoder.line(alignLeftRightLine(time, date, encoder.columns));
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
            .resize({ width: Math.floor(encoder.printableWidth * maxBodyPct), withoutEnlargement: true })
            .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

        // Pad the shrunk image back up to the printable width, centering it
        const image = await centerImage(resized, encoder.printableWidth);

        encoder.image(image, { algorithm: "atkinson" });
    }

    if (item.text) {
        if (EMOJI_ONLY_REGEX.test(item.text)) {
            const dpi = 580; // This doesn't seem to work on Linux, set so macOS looks similar
            const spacer = process.platform === "darwin" ? "\u2002" : ""; // Apple Emoji needs some more space
            const emojiText = item.text.replace(/\s/gu, "");
            const spaced = Array.from(GRAPHEME_SEGMENTER.segment(emojiText), ({ segment }) => segment).join(spacer);
            const rendered = await sharp({ text: { text: spaced, dpi, rgba: true } })
                .resize({ width: Math.floor(encoder.printableWidth * maxBodyPct) })
                .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

            const image = await centerImage(rendered, encoder.printableWidth);

            encoder.image(image, { algorithm: "atkinson" });
        } else {
            // TODO: Support inline emoji rendering
            // TODO: libvips (sharp) can handle this, but it'll need a suitable pixel font
            const maxTextColumns = Math.ceil(encoder.columns * 0.85);
            const { lines, wrapped } = wrapText(item.text, maxTextColumns);
            
            if (item.image || lines.length < 3) {
                encoder.newline();
            }

            if (!wrapped) {
                encoder.align("center");
                for (const line of lines) {
                    encoder.line(line);
                }
                encoder.align("left");
            } else {
                const leftPadding = Math.floor((encoder.columns - maxTextColumns) / 2);
                for (const line of lines) {
                    encoder.line(`${" ".repeat(leftPadding)}${line}`);
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
    renderItemTrailer(encoder, item);
}

function renderItemTrailer(encoder, item) {
    // TODO: Would like to display these as a small logo instead
    // TODO: Having trouble rendering inline images, which also affects text emoji rendering
    const knownSources = {
        meshcore: { label: "MeshCore" },
        telegram: { label: "Telegram", prefix: "@" },
    };
    
    const sourceInfo = knownSources[item.source] || { label: item.source };
    const fromLabel = `${sourceInfo.prefix || ""}${item.from}`;
    const sourceLabel = sourceInfo.label;
    
    encoder.line(alignLeftRightLine(fromLabel, sourceLabel, encoder.columns));
}

function alignLeftRightLine(left, right, width) {
    const rightText = fitToWidth(right, width);
    const leftText = fitToWidth(left, Math.max(0, width - rightText.length - 1));

    return `${leftText}${" ".repeat(Math.max(0, width - leftText.length - rightText.length))}${rightText}`;
}

function fitToWidth(text, width) {
    return Array.from(text).slice(0, width).join("");
}

function wrapText(text, width) {
    const lines = [];
    let wrapped = false;

    for (const paragraph of text.split(/\r?\n/u)) {
        const paragraphStart = lines.length;
        let line = "";

        for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) {
            const characters = Array.from(word);

            while (characters.length > width) {
                wrapped = true;
                if (line) {
                    lines.push(line);
                    line = "";
                }
                lines.push(characters.splice(0, width).join(""));
            }

            const remainingWord = characters.join("");
            if (!remainingWord) {
                continue;
            }

            if (line && Array.from(line).length + 1 + characters.length > width) {
                wrapped = true;
                lines.push(line);
                line = remainingWord;
            } else {
                line = line ? `${line} ${remainingWord}` : remainingWord;
            }
        }

        if (line || lines.length === paragraphStart) {
            lines.push(line);
        }
    }

    return { lines, wrapped };
}

function formatTimestamp(timestamp) {
    const now = new Date(timestamp * 1000);

    const year = String(now.getFullYear() - 2000).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    return {
        date: `${day}/${month}/${year}`,
        time: `${hours}:${minutes}`,
    };
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
