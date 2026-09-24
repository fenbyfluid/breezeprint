import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import { ReceiptPrinterRenderer, stitch, toPng } from '@point-of-sale/receipt-printer-renderer';

const encoder = new ReceiptPrinterEncoder({
    printerModel: 'pos-8360'
});

const renderer = new ReceiptPrinterRenderer({
    language: encoder.language,
    width: encoder.printableWidth,
    commands: [ 'cut', 'pulse' ],
    capabilities: encoder.printerCapabilities,
});

const bytes = encoder.initialize()
    .newline()
    .line('Hello, World!')
    .newline()
    .encode();

console.log(bytes);

const items = renderer.render(bytes);

console.log(items);

const paper = stitch(items);

// Pad the image from the 72mm printable area to the 80mm paper area
// Quite hacky as receipt-printer-renderer doesn't export its bitmap class
const padded = { width: paper.width + 64, height: paper.height, data: null };
padded.data = new Uint8Array(((padded.width + 7) >> 3) * padded.height);
for (let row = 0; row < paper.height; ++row) {
    const sourceRowBytes = (paper.width + 7) >> 3;
    const paddedRowBytes = (padded.width + 7) >> 3;
    const sourceStart = row * sourceRowBytes;
    const paddedStart = row * paddedRowBytes + 4; // 4 bytes = 32 pixels left padding

    padded.data.set(
        paper.data.subarray(sourceStart, sourceStart + sourceRowBytes),
        paddedStart
    );
}

const image = await toPng(padded);

console.log(image);

const encodedImage = Buffer.from(image, 'binary').toString('base64');
console.log(`data:image/png;base64,${encodedImage}`);
