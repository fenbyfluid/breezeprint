import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import { ReceiptPrinterRenderer, stitch, toPng } from "@point-of-sale/receipt-printer-renderer";

// Render a run of only emoji (and joiners/variation selectors) as an image
const EMOJI_ONLY_REGEX = /^(\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u;

export async function renderReceipt(item) {
    console.log("[printer] renderReceipt", item);

    // TODO: Check this against our printer capabilities
    const encoder = new ReceiptPrinterEncoder({
        printerModel: "pos-8360",
    });

    const renderer = new ReceiptPrinterRenderer({
        language: encoder.language,
        width: encoder.printableWidth,
        commands: ["cut", "pulse"],
        capabilities: encoder.printerCapabilities,
    });

    // TODO: Render the incoming messages to receipt printer commands
    const bytes = encoder.initialize()
        .newline()
        .line("Hello, World!")
        .newline()
        .encode();

    // TODO: Send command bytes to a printer
    console.log('[printer] command bytes:', bytes);

    // TODO: OR, send the rendered image + commands to a printer
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
