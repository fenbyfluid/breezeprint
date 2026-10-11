import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { ReceiptPrinterRenderer, stitch, toPng } from "@point-of-sale/receipt-printer-renderer";
import sharp from "sharp";
import { CustomCharacters, MAX_GLYPHS } from "./custom-characters.js";

// Render a run of only emoji (and joiners/variation selectors) as an image
const EMOJI_ONLY_REGEX = /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\p{Zs}\t]+$/u;
const INLINE_EMOJI_REGEX = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Measured [wanted ink, ink to send] points; the paper prints much darker than the preview
const INK_CURVE = [
    [0, 0], [0.08, 0.15], [0.25, 0.25], [0.3, 0.26],
    [0.45, 0.35], [0.7, 0.46], [0.9, 0.57], [0.95, 0.7], [1, 0.75],
];

const TONE_LUT = Uint8Array.from({ length: 256 }, (_, value) => {
    const ink = 1 - value / 255;
    let i = 1;
    while (i < INK_CURVE.length - 1 && ink > INK_CURVE[i][0]) i++;
    const [x0, y0] = INK_CURVE[i - 1];
    const [x1, y1] = INK_CURVE[i];
    return Math.round(255 * (1 - (y0 + ((y1 - y0) * (ink - x0)) / (x1 - x0))));
});

function compensateTone(image) {
    const { data, info } = image;
    for (let i = 0; i < data.length; i += info.channels) {
        data[i] = TONE_LUT[data[i]];
        data[i + 1] = TONE_LUT[data[i + 1]];
        data[i + 2] = TONE_LUT[data[i + 2]];
    }
    return image;
}

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
 * @param {{ compensate?: boolean }} [options] compensate: apply tone mapping for physical paper
 */
export async function encodeItem(encoder, item, { compensate = false } = {}) {
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
    await encodeLine(encoder, compensate, ...alignLeftRight([timeLabel], [dateLabel], encoder.columns));
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
        const centered = await centerImage(resized, encoder.printableWidth);
        const image = compensate ? compensateTone(centered) : centered;

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

            const centered = await centerImage(rendered, encoder.printableWidth);
            const image = compensate ? compensateTone(centered) : centered;

            encoder.image(image, { algorithm: "atkinson" });
        } else {
            const maxTextColumns = Math.ceil(encoder.columns * 0.85);
            const { lines, wrapped } = wrapParts(await toParts(item.text), maxTextColumns);
            
            if (item.image || lines.length < 3) {
                encoder.newline();
            }

            if (!wrapped) {
                encoder.align("center");
                for (const line of lines) {
                    await encodeLine(encoder, compensate, ...line);
                }
                encoder.align("left");
            } else {
                const leftPadding = Math.floor((encoder.columns - maxTextColumns) / 2);
                for (const line of lines) {
                    await encodeLine(encoder, compensate, " ".repeat(leftPadding), ...line);
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
    await encodeItemTrailer(encoder, item, compensate);
}

async function encodeItemTrailer(encoder, item, compensate) {
    // The icons here are all 36x24 1-bit gifs, the icons are aligned 1px from the right edge of the canvas
    const knownSources = {
        meshcore: { 
            label: "MeshCore",
            icon: "R0lGODlhJAAYAPABAAAAAP///yH5BAQAAAAALAAAAAAkABgAAAJmjA1wy73pTlKxIhgntXk6zXEgM4YdJnlpiAalq8JtU76xvH13XN/nNuq1bDzVbqjJHSnLR9KpxDRTxCgTaZ1erqhqlsoF+nTd4rdShYpz5PX5wnpv2SY1bVyft/Mk/JYPZTEDOFMAADs=",
        },
        telegram: {
            label: "Telegram",
            icon: "R0lGODlhJAAYAPABAAAAAP///yH5BAQAAAAALAAAAAAkABgAAAJNjI+pe+DAomzPzYuqxld7zngiBGajWBqnupUniWIvGYzdTMUhnuvJbOn5TCtiMTIEgoLGY4qlfAqdTyBTCrVhf9RttuJdDMNC8o5mKAAAOw==",
        },
        discord: { 
            label: "Discord",
            icon: "R0lGODlhJAAYAPMPAAAAAA8PDx8fHyAgID8/P09PT39/f4+Pj5+fn6CgoL+/v8DAwM/Pz9/f3+/v7////yH5BAQAAAAALAAAAAAkABgAAAR18MlJ5QCgTty011iYScuyicnniWzrqpQrz/Az360B43yo9kDdCtj7EIugIzLmKkhkEgK04mIwRZTDi2LYTrQh61WkGGOpPnTLnD6d3Sx22xaH159KoDzvpfNxe39veHU4AYSDEwh9Ri0OMAKJPyFCNXiWlx4RADs=",
        },
    };
    
    const sourceInfo = knownSources[item.source] || { label: item.source };

    const source = sourceInfo.icon
        ? { image: await sharp(Buffer.from(sourceInfo.icon, "base64")).raw().ensureAlpha().toBuffer({ resolveWithObject: true }) }
        : sourceInfo.label;

    await encodeLine(encoder, compensate, ...alignLeftRight(await toParts(item.from), await toParts(source), encoder.columns));
}

/**
 * A part is either plain text or `{ image, options? }`, a raw (12*N)x24 RGBA image printed as custom characters.
 * Strings are split into plain text and rasterized emoji parts.
 */
async function toParts(...args) {
    const parts = [];

    for (const arg of args) {
        if (typeof arg !== "string") {
            parts.push(arg);
            continue;
        }

        let plain = "";

        for (const { segment } of GRAPHEME_SEGMENTER.segment(arg)) {
            if (!INLINE_EMOJI_REGEX.test(segment)) {
                plain += segment;
                continue;
            }

            if (plain) {
                parts.push(plain);
                plain = "";
            }

            parts.push(await rasterizeEmoji(segment));
        }

        if (plain) {
            parts.push(plain);
        }
    }

    return parts;
}

async function rasterizeEmoji(emoji) {
    try {
        const renderSize = 24;
        const image = await sharp({ text: { text: emoji, width: renderSize, height: renderSize, wrap: "none", rgba: true } })
            .trim({ lineArt: true })
            .resize(renderSize, renderSize, { fit: "contain", background: "white" })
            .flatten({ background: "white" })
            .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

        return { image, options: { algorithm: "atkinson", autoCenter: true } };
    } catch (error) {
        console.error("[render] Failed to rasterize emoji", emoji, error);
        return "?";
    }
}

function partColumns(part) {
    if (typeof part !== "string") {
        return CustomCharacters.columns(part.image);
    }

    return Array.from(GRAPHEME_SEGMENTER.segment(part)).length;
}

function alignLeftRight(left, right, width) {
    const leftWidth = left.reduce((sum, part) => sum + partColumns(part), 0);
    const rightWidth = right.reduce((sum, part) => sum + partColumns(part), 0);

    const gapWidth = width - leftWidth - rightWidth;
    if (gapWidth >= 2) {
        return [...left, " ".repeat(gapWidth), ...right];
    }

    const availableLeftWidth = width - rightWidth - 2;
    const truncated = [];
    let remainingWidth = Math.max(0, availableLeftWidth - 2);
    let truncatedWidth = 0;
    outer: for (const part of left) {
        if (typeof part !== "string") {
            const size = partColumns(part);
            if (size > remainingWidth) break;
            truncated.push(part);
            remainingWidth -= size;
            truncatedWidth += size;
            continue;
        }

        for (const { segment } of GRAPHEME_SEGMENTER.segment(part)) {
            const size = partColumns(segment);
            if (size > remainingWidth) break outer;
            truncated.push(segment);
            remainingWidth -= size;
            truncatedWidth += size;
        }
    }

    if (availableLeftWidth >= 2) {
        const ellipsis = ellipsisPart();
        truncated.push(ellipsis);
        truncatedWidth += partColumns(ellipsis);
    }
    return [...truncated, " ".repeat(Math.max(2, width - truncatedWidth - rightWidth)), ...right];
}

function ellipsisPart() {
    const ellipsis = Buffer.alloc(24 * 24 * 4, 255);

    const periodPixels = [
        [1, 14], [2, 14],
        [0, 15], [1, 15], [2, 15], [3, 15],
        [0, 16], [1, 16], [2, 16], [3, 16],
        [1, 17], [2, 17],
    ];

    for (const left of [4, 10, 16]) {
        for (const [x, y] of periodPixels) {
            const offset = (y * 24 + left + x) * 4;
            ellipsis.fill(0, offset, offset + 3);
        }
    }

    return {
        image: {
            data: ellipsis,
            info: { width: 24, height: 24, channels: 4, depth: "uchar" },
        },
    };
}

// Breaks on whitespace within text parts; image parts join whatever word they touch
function wrapParts(parts, width) {
    const lines = [];
    let wrapped = false;
    let line = [];
    let columns = 0;
    let glyphs = 0;
    let word = [];
    let wordWidth = 0;

    const pushLine = () => {
        lines.push(line);
        line = [];
        columns = 0;
        glyphs = 0;
    };

    const flushWord = () => {
        if (!word.length) {
            return;
        }
        if (columns && columns + 1 + wordWidth > width) {
            wrapped = true;
            pushLine();
        }
        if (columns) {
            line.push(" ");
            columns++;
        }
        for (const atom of word) {
            const size = partColumns(atom);
            const glyphSize = typeof atom === "string" ? 0 : size;
            if (columns + size > width || glyphs + glyphSize > MAX_GLYPHS) {
                wrapped = true;
                pushLine();
            }
            line.push(atom);
            columns += size;
            glyphs += glyphSize;
        }
        word = [];
        wordWidth = 0;
    };

    for (const part of parts) {
        const atoms = typeof part === "string" ? Array.from(GRAPHEME_SEGMENTER.segment(part), ({ segment }) => segment) : [part];
        for (const atom of atoms) {
            if (atom === "\n" || atom === "\r\n") {
                flushWord();
                pushLine();
            } else if (typeof atom === "string" && /^\s+$/u.test(atom)) {
                flushWord();
            } else {
                word.push(atom);
                wordWidth += partColumns(atom);
            }
        }
    }
    flushWord();
    pushLine();

    return { lines, wrapped };
}

async function encodeLine(encoder, compensate, ...args) {
    const characters = new CustomCharacters(encoder);
    let plain = "";

    for (const part of await toParts(...args)) {
        if (typeof part === "string") {
            plain += part;
            continue;
        }

        if (plain) {
            encoder.text(plain);
            plain = "";
        }

        // Only dithered parts are tone-compensated; thresholded parts (icons, ellipsis) are pure black and white
        const dithered = (part.options?.algorithm ?? "threshold") !== "threshold";
        characters.print(compensate && dithered ? compensateTone(part.image) : part.image, part.options);
    }

    if (plain) {
        encoder.text(plain);
    }

    encoder.newline();
}

const CODEPAGE_MAPPING = "youku";

async function toPreviewImage(encoder) {
    const renderer = new ReceiptPrinterRenderer({
        language: encoder.language,
        width: encoder.printableWidth,
        commands: [],
        capabilities: encoder.printerCapabilities,
        codepageMapping: CODEPAGE_MAPPING,
    });

    // Combine the rendered items into a single paper bitmap
    const paper = stitch(renderer.render(encoder.encode()));

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

    return toPng(padded);
}

/**
 * Lays out an item for the printer: `bytes` to send, and a PNG `image` preview of the paper.
 * @param {Parameters<typeof encodeItem>[1]} item
 */
export async function renderItem(item) {
    const createEncoder = () => new ReceiptPrinterEncoder({
        columns: 48,
        imageMode: "raster",
        feedBeforeCut: 5,
        feedAfterBlock: false,
        newline: "\n",
        codepageMapping: CODEPAGE_MAPPING,
    });

    // Preview: no tone mapping or cut
    const previewEncoder = createEncoder();
    previewEncoder.initialize();
    previewEncoder.newline();
    await encodeItem(previewEncoder, item);
    previewEncoder.newline();

    // Print: tone-mapped for the paper, ending with a cut
    const printEncoder = createEncoder();
    printEncoder.initialize();
    await encodeItem(printEncoder, item, { compensate: true });
    printEncoder.newline();
    printEncoder.cut("partial");

    return {
        bytes: printEncoder.encode(),
        image: await toPreviewImage(previewEncoder),
    };
}
