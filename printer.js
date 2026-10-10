import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// usblp allows one opener at a time, so wait out EBUSY
async function openPrinter(path) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await open(path, "r+");
        } catch (error) {
            if (error.code !== "EBUSY" || attempt >= 50) throw error;
            await sleep(100);
        }
    }
}

let paperAtOutput = false;

// DLE EOT 1 replies with one byte; bit 7 is vendor-specific and set while printed paper is at the output slot
async function checkPaper(handle, reason) {
    try {
        await handle.writeFile(Buffer.from([0x10, 0x04, 0x01]));
        const status = Buffer.alloc(1);
        await handle.read(status, 0, 1, null); // blocks until the printer replies, usually within 20ms

        const atOutput = (status[0] & 0x80) !== 0;
        if (atOutput !== paperAtOutput) {
            console.log(`[printer] Paper ${atOutput ? "now at output" : "taken"} (${reason})`);
        }
        paperAtOutput = atOutput;
    } catch (error) {
        console.warn(`[printer] Paper status check (${reason}) failed:`, error.message);
    }
}

const PAPER_POLL_MIN_MS = 500;
const PAPER_POLL_MAX_MS = 10000;

let paperTimer = null;
let paperWatchStart = 0;

// Polls quickly after a print, then slows to 1/30th of the time the paper has been waiting (10s after 5 minutes)
function watchPaper(path) {
    clearTimeout(paperTimer);
    paperWatchStart = Date.now();
    paperTimer = setTimeout(() => pollPaper(path), PAPER_POLL_MIN_MS).unref();
}

async function pollPaper(path) {
    try {
        await enqueue(async () => {
            const handle = await openPrinter(path);
            try {
                await checkPaper(handle, "timer");
            } finally {
                await handle.close();
            }
        });
    } catch (error) {
        // Powered off or unplugged: the paper's fate is unknown, so stop until the next print
        console.warn("[printer] Paper status check (timer) failed, no longer watching:", error.message);
        paperAtOutput = false;
    }

    if (paperAtOutput) {
        const delay = Math.min(Math.max((Date.now() - paperWatchStart) / 30, PAPER_POLL_MIN_MS), PAPER_POLL_MAX_MS);
        clearTimeout(paperTimer);
        paperTimer = setTimeout(() => pollPaper(path), delay).unref();
    }
}

// Callers can deliver concurrently, so jobs must not interleave on the port
let queue = Promise.resolve();

function enqueue(task) {
    const job = queue.then(task);
    queue = job.catch(() => {});
    return job;
}

/**
 * Sends encoded bytes to the printer, powering it on first if needed.
 * @param {string | undefined} path
 * @param {Uint8Array} bytes
 * @param {import("./power.js").PrinterPower} [power]
 */
export function print(path, bytes, power) {
    return enqueue(async () => {
        if (!path) {
            console.log("[printer] command bytes:", Buffer.from(bytes).toString("hex"));

            throw new Error("no printer configured");
        }

        try {
            await power?.acquire();
        } catch (error) {
            throw new Error("printer failed to power on", { cause: error });
        }

        let handle;
        try {
            handle = await openPrinter(path);
            await checkPaper(handle, "before print");
            await handle.writeFile(bytes);

            // It takes a moment to reach the slot, so assume it will until seen taken
            console.log(`[printer] Paper ${paperAtOutput ? "already" : "now"} at output (print)`);
            paperAtOutput = true;
            watchPaper(path);
        } catch (error) {
            if (error.code === "ENOENT") {
                throw new Error("printer not connected", { cause: error });
            }

            throw new Error("unknown error", { cause: error });
        } finally {
            await handle?.close();
            power?.release();
        }
    });
}
