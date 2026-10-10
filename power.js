import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 250;

/**
 * Powers the printer via a GPIO pin (using `pinctrl`) on demand, and powers it off after an idle period.
 * Callers must serialise use of `acquire()`/`release()`; the print queue already does.
 */
export class PrinterPower {
    #on = false;
    #timer = null;

    constructor({ gpio, devicePath, idleMs, waitMs, settleMs }) {
        this.gpio = gpio;
        this.devicePath = devicePath;
        this.idleMs = idleMs;
        this.waitMs = waitMs;
        this.settleMs = settleMs;
    }

    // If the printer is already up (e.g. service restart), adopt that state rather than cycling it
    async init() {
        if (await this.#deviceExists()) {
            console.log("[power] Printer already present at startup");
            this.#on = true;
            this.#armIdleTimer();
        }
    }

    async acquire() {
        clearTimeout(this.#timer);

        let fresh = false;
        if (!this.#on) {
            console.log(`[power] Powering on printer (GPIO ${this.gpio})`);
            await this.#setPin(true);
            this.#on = true;
            fresh = true;
        }

        try {
            await this.#waitForDevice();
        } catch (error) {
            // Pin stays high so the next print retries; keep the idle timer so it can't stay on forever
            this.#armIdleTimer();
            throw error;
        }

        if (fresh) {
            await sleep(this.settleMs);
        }
    }

    release() {
        this.#armIdleTimer();
    }

    #armIdleTimer() {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
            console.log(`[power] Idle for ${this.idleMs}ms, powering off printer`);
            this.#setPin(false)
                .then(() => { this.#on = false; })
                .catch((error) => console.error("[power] Failed to power off printer", error));
        }, this.idleMs);
        this.#timer.unref();
    }

    async #waitForDevice() {
        const deadline = Date.now() + this.waitMs;
        while (!(await this.#deviceExists())) {
            if (Date.now() >= deadline) {
                throw new Error(`printer did not appear within ${this.waitMs}ms of power on`);
            }
            await sleep(POLL_INTERVAL_MS);
        }
    }

    async #deviceExists() {
        try {
            await access(this.devicePath);
            return true;
        } catch {
            return false;
        }
    }

    async #setPin(high) {
        await execFileAsync("pinctrl", ["set", String(this.gpio), "op", high ? "dh" : "dl"]);
    }
}
