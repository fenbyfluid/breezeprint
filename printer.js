import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// Typical status reply is ~20ms; this is a ceiling to tune from the logged latencies
const STATUS_REPLY_TIMEOUT_MS = 500;
const STATUS_SLOW_REPLY_MS = 100;
// Resets whenever the printer accepts bytes, so only a stalled printer fails
const WRITE_STALL_TIMEOUT_MS = 15000;
const POLL_SLEEP_MS = 10;

// Non-blocking so a missing reply or full buffer can never park a thread; usblp allows one opener, so wait out EBUSY
async function openPrinter(path) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await open(path, constants.O_RDWR | constants.O_NONBLOCK);
        } catch (error) {
            if (error.code !== "EBUSY" || attempt >= 50) throw error;
            await sleep(100);
        }
    }
}

async function writeAll(handle, bytes) {
    let offset = 0;
    let lastProgress = Date.now();
    while (offset < bytes.length) {
        try {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            offset += bytesWritten;
            if (bytesWritten > 0) {
                lastProgress = Date.now();
                continue;
            }
        } catch (error) {
            if (error.code !== "EAGAIN") throw error;
        }
        if (Date.now() - lastProgress > WRITE_STALL_TIMEOUT_MS) {
            throw new Error(`printer accepted no data for ${WRITE_STALL_TIMEOUT_MS}ms`);
        }
        await sleep(POLL_SLEEP_MS);
    }
}

// Returns null when nothing is readable right now
async function readNow(handle) {
    const byte = Buffer.alloc(1);
    try {
        const { bytesRead } = await handle.read(byte, 0, 1, null);
        return bytesRead > 0 ? byte[0] : null;
    } catch (error) {
        if (error.code !== "EAGAIN") throw error;
        return null;
    }
}

// Discards unread bytes so a late reply from an earlier query can't be mistaken for the next one
async function flush(handle) {
    let count = 0;
    while ((await readNow(handle)) !== null) count++;
    return count;
}

async function readReply(handle) {
    const deadline = Date.now() + STATUS_REPLY_TIMEOUT_MS;
    do {
        const byte = await readNow(handle);
        if (byte !== null) return byte;
        await sleep(POLL_SLEEP_MS);
    } while (Date.now() < deadline);
    return null;
}

// Returns the DLE EOT 1 status byte, or null if the printer didn't reply in time
async function queryStatus(handle) {
    const flushed = await flush(handle);
    const start = Date.now();
    await writeAll(handle, Buffer.from([0x10, 0x04, 0x01]));
    const status = await readReply(handle);
    const elapsed = Date.now() - start;
    if (flushed > 0) {
        console.warn(`[printer] Flushed ${flushed} stale status byte(s) before query`);
    }
    if (status !== null && elapsed > STATUS_SLOW_REPLY_MS) {
        console.warn(`[printer] Slow status reply 0x${status.toString(16).padStart(2, "0")} after ${elapsed}ms`);
    }
    return status;
}

/** Emits "taken" when printed paper is seen to have been removed from the output slot. */
export const paperEvents = new EventEmitter();

let paperAtOutput = false;

// Bit 7 of the DLE EOT 1 reply is vendor-specific and set while printed paper is at the output slot
async function checkPaper(handle, reason) {
    try {
        let status = await queryStatus(handle);
        if (status === null) {
            console.warn(`[printer] Paper status check (${reason}) got no reply`);
            return;
        }

        // Paper vanishing is only believed if a freshly flushed second query agrees
        if (paperAtOutput && (status & 0x80) === 0) {
            status = await queryStatus(handle);
            if (status === null) {
                console.warn(`[printer] Paper status confirmation (${reason}) got no reply`);
                return;
            }
        }

        const atOutput = (status & 0x80) !== 0;
        const wasAtOutput = paperAtOutput;
        if (atOutput !== wasAtOutput) {
            console.log(`[printer] Paper ${atOutput ? "now at output" : "taken"} (${reason})`);
        }
        paperAtOutput = atOutput;
        if (wasAtOutput && !atOutput) {
            paperEvents.emit("taken");
        }
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
        // Powered off or unplugged: stop polling but keep the paper pending, as the sensor persists and the next print's check can still report it taken
        console.warn("[printer] Paper status check (timer) failed, no longer watching:", error.message);
        return;
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
            await writeAll(handle, bytes);
            // usblp accepts this write only after the job's last USB transfer completes; closing earlier would kill it
            await queryStatus(handle);

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
