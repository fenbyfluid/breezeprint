import { basename } from "node:path";
import { startMeshCore } from "./meshcore.js";
import { startTelegramBot } from "./telegram.js";
import { renderItem } from "./render.js";
import { print } from "./printer.js";
import { PrinterPower } from "./power.js";

// Whitespace-separated, as Telegram bot tokens contain a colon themselves
const splitList = (value) => value?.split(/\s+/).filter(Boolean) ?? [];

const config = {
    printerDevicePath: process.env.PRINTER_DEVICE_PATH,
    meshcoreSerialPaths: splitList(process.env.MESHCORE_SERIAL_PATH),
    meshcoreLogRxData: process.env.MESHCORE_LOG_RX_DATA === "true",
    telegramBotTokens: splitList(process.env.TELEGRAM_BOT_TOKEN),
    printerPowerGpio: process.env.PRINTER_POWER_GPIO,
    printerPowerIdleHours: Number(process.env.PRINTER_POWER_IDLE_HOURS ?? 36),
    printerPowerWaitSeconds: Number(process.env.PRINTER_POWER_WAIT_SECONDS ?? 30),
    printerPowerSettleMs: Number(process.env.PRINTER_POWER_SETTLE_MS ?? 1000),
};

let printerPower = null;
if (config.printerPowerGpio) {
    if (!config.printerDevicePath) {
        throw new Error("PRINTER_POWER_GPIO requires PRINTER_DEVICE_PATH");
    }
    printerPower = new PrinterPower({
        gpio: config.printerPowerGpio,
        devicePath: config.printerDevicePath,
        idleMs: config.printerPowerIdleHours * 60 * 60 * 1000,
        waitMs: config.printerPowerWaitSeconds * 1000,
        settleMs: config.printerPowerSettleMs,
    });
    await printerPower.init();
}

const createOnItemReceived = (name) => async (item) => {
    const { bytes, image } = await renderItem(item);

    let printError = null;
    try {
        await print(config.printerDevicePath, bytes, printerPower);
    } catch (error) {
        console.error(`[index] [${name}] Failed to send to printer`, error);
        printError = error;
    }

    console.log(`[index] [${name}] Processed item`,
        item,
        `data:image/png;base64,${Buffer.from(image, "binary").toString("base64")}`);

    return { image, printError };
};

if (config.telegramBotTokens.length === 0) {
    console.warn("[index] TELEGRAM_BOT_TOKEN not set; skipping Telegram startup.");
}

config.telegramBotTokens.forEach((token) => {
    // Only the bot ID before the colon; the rest of the token is secret
    const name = `telegram ${token.split(":")[0]}`;
    startTelegramBot({ token, onItemReceived: createOnItemReceived(name) }).then(() => {
        console.log(`[index] [${name}] Telegram module started`);
    });
});

if (config.meshcoreSerialPaths.length === 0) {
    console.warn("[index] MESHCORE_SERIAL_PATH not set; skipping MeshCore startup.");
}

config.meshcoreSerialPaths.forEach((serialPath) => {
    const name = `meshcore ${basename(serialPath)}`;
    startMeshCore({
        serialPath,
        logRxData: config.meshcoreLogRxData,
        onItemReceived: createOnItemReceived(name),
    }).then(() => {
        console.log(`[index] [${name}] MeshCore module started`);
    });
});
