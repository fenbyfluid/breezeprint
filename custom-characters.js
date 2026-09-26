import Dither from "canvas-dither";

const FIRST_CODE = 0x21;
const LAST_CODE = 0x7e;
const GLYPH_WIDTH = 12;
const GLYPH_HEIGHT = 24;
const SELECT_CUSTOM = Uint8Array.from([0x1b, 0x25, 1]);
const SELECT_STANDARD = Uint8Array.from([0x1b, 0x25, 0]);

export class CustomCharacters {
    #encoder;
    #entries = new Map();
    #nextCode = FIRST_CODE;

    constructor(encoder) {
        if (encoder.language !== "esc-pos" || !encoder.printerCapabilities.fonts.A.size.startsWith("12x24")) {
            throw new Error("Custom characters require ESC/POS Font A (12x24)");
        }
        this.#encoder = encoder;
    }

    has(key) {
        return this.#entries.has(key);
    }

    width(key) {
        const entry = this.#entries.get(key);
        if (!entry) throw new Error(`Unknown custom character: ${key}`);
        return entry.length;
    }

    bytes(key) {
        const codes = this.#entries.get(key);
        if (!codes) throw new Error(`Unknown custom character: ${key}`);
        return Uint8Array.from([...SELECT_CUSTOM, ...Array.from(codes, (character) => character.charCodeAt(0)), ...SELECT_STANDARD]);
    }

    define(key, image, options) {
        if (this.#entries.has(key)) throw new Error(`Custom character already defined: ${key}`);
        const { data, info: { width, height, channels, depth } } = image;
        if (height !== GLYPH_HEIGHT || width < GLYPH_WIDTH || width % GLYPH_WIDTH !== 0) {
            throw new RangeError("Custom character canvas must be (12*N)x24 pixels");
        }
        if (channels !== 4 || depth !== "uchar" || !Buffer.isBuffer(data) || data.length !== width * height * 4) {
            throw new TypeError("Custom character canvas must be raw 8-bit RGBA data");
        }

        const length = width / GLYPH_WIDTH;
        if (this.#nextCode + length - 1 > LAST_CODE) {
            throw new RangeError("No printable custom character slots remain");
        }

        const { algorithm, threshold, autoCenter } = { algorithm: "threshold", threshold: 128, autoCenter: false, ...options };

        const bitmap = { data, width, height };
        switch (algorithm) {
            case "threshold": Dither.threshold(bitmap, threshold); break;
            case "bayer": Dither.bayer(bitmap, threshold); break;
            case "floydsteinberg": Dither.floydsteinberg(bitmap); break;
            case "atkinson": Dither.atkinson(bitmap); break;
            default: throw new Error(`Unknown algorithm: ${algorithm}`);
        }

        // Emoji end up visually off-center once dithered, so we re-center them
        if (autoCenter) {
            autoCenterBitmap(bitmap);
        }

        const command = [0x1b, 0x26, 3, this.#nextCode, this.#nextCode + length - 1];
        for (let glyph = 0; glyph < length; glyph++) {
            command.push(GLYPH_WIDTH);
            for (let column = 0; column < GLYPH_WIDTH; column++) {
                for (let block = 0; block < 3; block++) {
                    let bits = 0;
                    for (let bit = 0; bit < 8; bit++) {
                        const row = block * 8 + bit;
                        const offset = (row * width + glyph * GLYPH_WIDTH + column) * 4;
                        if (bitmap.data[offset] === 0) bits |= 0x80 >> bit;
                    }
                    command.push(bits);
                }
            }
        }

        const codes = Array.from({ length }, (_, index) => this.#nextCode + index);
        this.#encoder.raw(Uint8Array.from(command));
        this.#entries.set(key, String.fromCharCode(...codes));
        this.#nextCode += length;
        return length;
    }

    print(key) {
        const codes = this.#entries.get(key);
        if (!codes) throw new Error(`Unknown custom character: ${key}`);
        if (codes.length > this.#encoder.columns) {
            throw new RangeError(`Custom character ${key} exceeds the printable line width`);
        }
        this.#encoder.raw(SELECT_CUSTOM);
        this.#encoder.text(codes);
        this.#encoder.raw(SELECT_STANDARD);
        return codes.length;
    }
}

// Centers the inked pixels within the canvas, treating the dominant edge value as the background
function autoCenterBitmap(bitmap) {
    // Font A glyphs only use 22 rows of the 24 row canvas
    const GLYPH_BOTTOM = 22;

    const { data, width, height } = bitmap;
    const stride = width * 4;

    let edgeDark = 0;
    let edgeTotal = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (y > 0 && y < height - 1 && x > 0 && x < width - 1) continue;
            if (data[y * stride + x * 4] === 0) edgeDark++;
            edgeTotal++;
        }
    }

    const background = edgeDark * 2 > edgeTotal ? 0 : 255;

    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[y * stride + x * 4] === background) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    if (right < 0) {
        return;
    }

    const dx = Math.floor((width - 1 - right - left) / 2);
    const dy = Math.max(-top, Math.min(Math.floor((GLYPH_BOTTOM - bottom - top) / 2), height - 1 - bottom));
    if (dx === 0 && dy === 0) {
        return;
    }

    const centered = Buffer.alloc(data.length, background);
    for (let y = top; y <= bottom; y++) {
        const start = y * stride + left * 4;
        data.copy(centered, (y + dy) * stride + (left + dx) * 4, start, start + (right - left + 1) * 4);
    }

    bitmap.data = centered;
}