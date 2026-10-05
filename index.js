import { basename } from "node:path";
import { startMeshCore } from "./meshcore.js";
import { startTelegramBot } from "./telegram.js";
import { renderReceipt } from "./printer.js";

// Whitespace-separated, as Telegram bot tokens contain a colon themselves
const splitList = (value) => value?.split(/\s+/).filter(Boolean) ?? [];

const config = {
    printerDevicePath: process.env.PRINTER_DEVICE_PATH,
    meshcoreSerialPaths: splitList(process.env.MESHCORE_SERIAL_PATH),
    meshcoreLogRxData: process.env.MESHCORE_LOG_RX_DATA === "true",
    telegramBotTokens: splitList(process.env.TELEGRAM_BOT_TOKEN),
};

const createOnItemReceived = (name) => async (item) => {
    const result = await renderReceipt(item, { devicePath: config.printerDevicePath });

    console.log(`[index] [${name}] Processed item`,
        item,
        `data:image/png;base64,${Buffer.from(result.image, "binary").toString("base64")}`);

    return result;
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
