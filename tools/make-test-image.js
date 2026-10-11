// Generates a test image for the image pathway: node tools/make-test-image.js [--bars] [output.png]
// --bars swaps the full test sheet for 50-dot tall bars at each 5% grey step.
// Send it to the bot as a file (document) so Telegram doesn't recompress it.
import sharp from "sharp";

// Matches render.js: floor(576 printable dots * 0.85), so the pipeline never rescales it
const args = process.argv.slice(2);
const barsLayout = args.includes("--bars");
const W = 489;
const MAX_H = 6000;
// Scales text and feature sizes; dot-level pattern pitches are never scaled
const S = 1.5;
const s = (n) => Math.round(n * S);
const pixels = new Uint8Array(W * MAX_H).fill(255);
const labels = [];
let y = 0;

// Percent is ink coverage: 0 = white paper, 100 = solid black
const gray = (pct) => Math.round(255 * (1 - pct / 100));
const set = (x, yy, v) => { if (x >= 0 && x < W) pixels[yy * W + x] = v; };

function label(text, x, yy, { size = 11, anchor = "start", weight = "normal", color = "black" } = {}) {
    labels.push({ text, x, y: yy, size: s(size), anchor, weight, color });
}

function fill(x0, y0, w, h, fn) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x0 + i, y0 + j, fn(i, j));
}

function heading(text) {
    y += s(8);
    label(text, 0, y + s(11), { size: 12, weight: "bold" });
    y += s(18);
}

function rampBar(from, to, name) {
    label(name, 0, y + s(9), { size: 10 });
    y += s(12);
    fill(0, y, W, s(22), (i) => gray(from + ((to - from) * i) / (W - 1)));
    y += s(26);
}

function stepBar(from, to, count, name) {
    label(name, 0, y + s(9), { size: 10 });
    y += s(12);
    for (let n = 0; n < count; n++) {
        const x0 = Math.round((n * W) / count);
        const x1 = Math.round(((n + 1) * W) / count);
        const pct = from + ((to - from) * n) / (count - 1);
        fill(x0, y, x1 - x0, s(26), () => gray(pct));
        label(`${Math.round(pct)}`, (x0 + x1) / 2, y + s(38), { size: 9, anchor: "middle" });
    }
    y += s(46);
}

// Cells wrap in rows of `perRow`, each filled by fn(i, j) -> 0/1 ink, with a caption underneath
function patternRow(cells, size = s(56), perRow = 5) {
    const gap = Math.floor((W - perRow * size) / (perRow - 1));
    for (let start = 0; start < cells.length; start += perRow) {
        cells.slice(start, start + perRow).forEach(([name, fn], c) => {
            const x0 = c * (size + gap);
            fill(x0, y, size, size, (i, j) => (fn(i, j) ? 0 : 255));
            label(name, x0 + size / 2, y + size + s(11), { size: 9, anchor: "middle" });
        });
        y += size + s(20);
    }
}

const vlines = (on, off) => (i) => i % (on + off) < on;
const hlines = (on, off) => (_, j) => j % (on + off) < on;
const diag = (on, off) => (i, j) => (i + j) % (on + off) < on;
const dots = (pitch) => (i, j) => i % pitch === 0 && j % pitch === 0;
const grid = (pitch) => (i, j) => i % pitch === 0 || j % pitch === 0;

if (barsLayout) {
    // 50-dot tall full-width bars, one per 5% step, labelled in a white column on the left
    const barH = 50;
    const labelW = 64;
    for (let pct = 0; pct <= 100; pct += 5) {
        fill(labelW, y, W - labelW, barH, () => gray(pct));
        label(`${pct}%`, labelW - 8, y + barH / 2 + s(4), { size: 10, anchor: "end" });
        y += barH;
    }
} else {
    // --- Continuous ramps
    heading("CONTINUOUS RAMPS (% ink)");
    rampBar(0, 100, "0-100%");
    rampBar(0, 50, "0-50%");
    rampBar(50, 100, "50-100%");

    // --- Discrete steps
    heading("DISCRETE STEPS (% ink)");
    stepBar(0, 100, 11, "0-100% in 10% steps");
    stepBar(0, 50, 11, "0-50% in 5% steps");
    stepBar(50, 100, 11, "50-100% in 5% steps");
    stepBar(0, 10, 11, "0-10% in 1% steps (highlights)");
    stepBar(90, 100, 11, "90-100% in 1% steps (shadows)");

    // --- Lines
    heading("LINES (on/off in dots)");
    patternRow([
        ["1/1", vlines(1, 1)], ["1/2", vlines(1, 2)], ["2/2", vlines(2, 2)], ["1/3", vlines(1, 3)],
        ["3/3", vlines(3, 3)], ["4/4", vlines(4, 4)], ["2/6", vlines(2, 6)], ["8/8", vlines(8, 8)],
    ]);
    patternRow([
        ["1/1", hlines(1, 1)], ["1/2", hlines(1, 2)], ["2/2", hlines(2, 2)], ["1/3", hlines(1, 3)],
        ["3/3", hlines(3, 3)], ["4/4", hlines(4, 4)], ["2/6", hlines(2, 6)], ["8/8", hlines(8, 8)],
    ]);
    patternRow([
        ["d 1/1", diag(1, 1)], ["d 1/2", diag(1, 2)], ["d 2/2", diag(2, 2)], ["d 1/3", diag(1, 3)],
        ["d 3/3", diag(3, 3)], ["d 4/4", diag(4, 4)], ["d 2/6", diag(2, 6)], ["d 8/8", diag(8, 8)],
    ]);

    // --- Grids and dot lattices
    heading("GRIDS AND DOT LATTICES (pitch in dots)");
    patternRow([
        ["grid 2", grid(2)], ["grid 3", grid(3)], ["grid 4", grid(4)], ["grid 6", grid(6)],
        ["grid 8", grid(8)], ["grid 12", grid(12)], ["grid 16", grid(16)], ["grid 24", grid(24)],
    ]);
    patternRow([
        ["check 1", (i, j) => (i + j) % 2 === 0], ["dots 2", dots(2)], ["dots 3", dots(3)], ["dots 4", dots(4)],
        ["dots 6", dots(6)], ["dots 8", dots(8)], ["chk 2", (i, j) => (((i >> 1) + (j >> 1)) & 1) === 0],
        ["chk 4", (i, j) => (((i >> 2) + (j >> 2)) & 1) === 0],
    ]);

    // --- Isolated features
    heading("SINGLE-DOT FEATURES");
    {
        const h = s(40);
        // Lines of widths 1..8 dots with equal gaps, then single-dot gaps in solid black
        let x = 0;
        for (let w = 1; w <= 8; w++) {
            fill(x, y, w, h, () => 0);
            x += w + 6;
        }
        label("widths 1-8", 0, y + h + s(11), { size: 9 });
        x += 12;
        const blockStart = x;
        for (let g = 1; g <= 6; g++) {
            fill(x, y, 14 + g, h, () => 0);
            fill(x + 7, y, g, h, () => 255);
            x += 14 + g + 4;
        }
        label("gaps 1-6", blockStart, y + h + s(11), { size: 9 });
        x += 12;
        // Isolated dots on white
        for (let n = 1; n <= 4; n++) {
            fill(x, y + 10, n, n, () => 0);
            x += n + 8;
        }
        label("dots 1-4", W, y + h + s(11), { size: 9, anchor: "end" });
        y += h + s(20);
    }

    // --- Rulers
    heading("RULER (ticks every 10 / 50 dots)");
    {
        const h = s(16);
        for (let x = 0; x < W; x += 10) {
            const th = x % 50 === 0 ? h : s(8);
            fill(x, y, 1, th, () => 0);
            if (x % 50 === 0) label(String(x), x + 2, y + h + s(9), { size: 8 });
        }
        y += h + s(14);
    }

    // --- Radial resolution targets and gradients
    heading("SIEMENS STAR / RADIAL / RINGS / DIAGONAL");
    {
        const size = 225;
        const cx = size / 2;
        const gap = W - 2 * size;
        const targets = [
            ["star", (r, dx, dy) => (Math.sin(24 * Math.atan2(dy, dx)) > 0 ? 0 : 255), true],
            ["radial", (r) => gray(100 * (1 - r / cx)), true],
            ["rings 2/2", (r) => (Math.floor(r / 2) % 2 === 0 ? 0 : 255), true],
            ["diagonal ramp", (r, dx, dy) => gray((100 * (dx + dy + size)) / (2 * size)), false],
        ];
        for (let row = 0; row < 2; row++) {
            for (let c = 0; c < 2; c++) {
                const [name, fn, circular] = targets[row * 2 + c];
                const x0 = c * (size + gap);
                fill(x0, y, size, size, (i, j) => {
                    const dx = i - cx + 0.5;
                    const dy = j - cx + 0.5;
                    const r = Math.hypot(dx, dy);
                    if (circular && r > cx) return 255;
                    return fn(r, dx, dy);
                });
                label(name, x0 + size / 2, y + size + s(11), { size: 9, anchor: "middle" });
            }
            y += size + s(20);
        }
    }

    // --- Text size ladder
    heading("TEXT LEGIBILITY (black on white / white on black)");
    {
        let ty = y;
        for (const size of [8, 9, 10, 12, 14, 18]) {
            ty += s(size) + s(3);
            label(`${s(size)}px Quick brown fox 0123456789`, 0, ty, { size });
        }
        y = ty + s(6);
        const bandH = s(36);
        fill(0, y, W, bandH, () => 0);
        label("Reversed text 18px 0123456789", 6, y + s(14), { size: 12, color: "white" });
        label("Reversed 14px 0123456789", 6, y + s(29), { size: 9, color: "white" });
        y += bandH + s(8);
    }
}

const H = y + 4;

// render.js trims uniform borders, so keep a 1-dot alternating frame to hold the exact size
for (let x = 0; x < W; x++) {
    set(x, 0, x % 2 ? 255 : 0);
    set(x, H - 1, (x + H) % 2 ? 255 : 0);
}
for (let j = 0; j < H; j++) {
    set(0, j, j % 2 ? 255 : 0);
    set(W - 1, j, (j + W) % 2 ? 255 : 0);
}

const escapeXml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${labels.map((l) =>
    `<text x="${l.x}" y="${l.y}" font-family="Helvetica, Arial, sans-serif" font-size="${l.size}" font-weight="${l.weight}" text-anchor="${l.anchor}" fill="${l.color}">${escapeXml(l.text)}</text>`
).join("")}</svg>`;

const output = args.find((a) => !a.startsWith("--")) ?? "test-image.png";
const base = Buffer.from(pixels.subarray(0, W * H));

await sharp(base, { raw: { width: W, height: H, channels: 1 } })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toFile(output);

console.log(`Wrote ${output} (${W}x${H})`);
