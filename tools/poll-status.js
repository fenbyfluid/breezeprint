// Sends read-only ESC/POS status queries one at a time and logs the replies, to find which one reports "paper taken".
// Runs a cycle, prints a short test receipt, then repeats a cycle every 10 seconds; changed replies are marked with "*".
// Only query commands are sent: no DLE ENQ (recovers errors) and no settings writers such as GS ( H.
// Usage: node tools/poll-status.js [--device /dev/usb/lp0] [--interval seconds] [--response-ms 200]
import { parseArgs } from "node:util";
import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const { values } = parseArgs({
    options: {
        device: { type: "string", default: process.env.PRINTER_DEVICE_PATH },
        interval: { type: "string", default: "10" },
        "response-ms": { type: "string", default: "200" },
    },
});

if (!values.device) {
    throw new Error("No printer configured: pass --device or set PRINTER_DEVICE_PATH");
}

const intervalMs = Number(values.interval) * 1000;
const responseMs = Number(values["response-ms"]);
if (!(intervalMs > 0 && responseMs > 0)) {
    throw new Error("--interval and --response-ms must be positive numbers");
}

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const EOT = 0x04;
const POLL_INTERVAL_MS = 20;
const QUIET_MS = 80;

const commands = [];
const add = (name, ...bytes) => commands.push({ name, bytes: Buffer.from(bytes) });

for (let n = 1; n <= 18; n++) add(`DLE EOT ${n}`, DLE, EOT, n);
for (const n of [1, 2, 0x31, 0x32]) add(`GS r ${n.toString(16)}`, GS, 0x72, n);
add("ESC u 0", ESC, 0x75, 0);
add("ESC v", ESC, 0x76);
for (const n of [1, 2, 3, 0x41, 0x42, 0x43, 0x44, 0x45]) add(`GS I ${n.toString(16)}`, GS, 0x49, n);

// Non-blocking so Ctrl-C always works: a blocking read parks a thread in the kernel and the process ignores SIGINT
const fd = openSync(values.device, constants.O_RDWR | constants.O_NONBLOCK);
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
const bits = (bytes) => Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0")).join(" ");

function shutdown() {
    closeSync(fd);
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function writeAll(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
        try {
            offset += writeSync(fd, bytes, offset);
        } catch (error) {
            if (error.code !== "EAGAIN") throw error;
            await sleep(POLL_INTERVAL_MS);
        }
    }
}

function readAvailable() {
    const chunk = Buffer.alloc(64);
    try {
        const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
        return chunk.subarray(0, bytesRead);
    } catch (error) {
        if (error.code !== "EAGAIN") throw error;
        return Buffer.alloc(0);
    }
}

// Waits up to responseMs for the first byte, then until the line has been quiet for QUIET_MS
async function query(bytes) {
    while (readAvailable().length > 0); // drop stale or unsolicited bytes so replies stay attributable

    await writeAll(bytes);

    const chunks = [];
    const startedAt = Date.now();
    let lastByteAt = 0;
    while (true) {
        const data = readAvailable();
        if (data.length > 0) {
            chunks.push(Buffer.from(data));
            lastByteAt = Date.now();
        }

        const now = Date.now();
        if (lastByteAt ? now - lastByteAt >= QUIET_MS : now - startedAt >= responseMs) {
            return Buffer.concat(chunks);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

let previous = new Map();

async function cycle(label) {
    log(`--- ${label} ---`);
    const current = new Map();

    for (const { name, bytes } of commands) {
        const reply = await query(bytes);
        const text = hex(reply);
        current.set(name, text);

        const changed = previous.size > 0 && previous.get(name) !== text;
        const shown = reply.length === 0 ? "(no reply)" : `${text}  [${bits(reply)}]`;
        console.log(`${changed ? "*" : " "} ${name.padEnd(12)} ${shown}`);
    }

    previous = current;
}

await writeAll(Buffer.from([ESC, 0x40]));

let number = 1;
await cycle(`cycle ${number++}: before printing`);

await writeAll(Buffer.concat([
    Buffer.from(`Probe test\n${new Date().toISOString()}\nTake the paper when it is cut.\n\n\n\n`, "latin1"),
    Buffer.from([GS, 0x56, 0x42, 0x00]), // feed and partial cut
]));
log("Test receipt sent; take the paper at some point, Ctrl-C to stop");

while (true) {
    const startedAt = Date.now();
    await cycle(`cycle ${number++}`);
    await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
}
