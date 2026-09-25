import { startMeshCore } from "./meshcore.js";
import { startTelegramBot } from "./telegram.js";
import { renderReceipt } from "./printer.js";

const onItemReceived = async (item) => {
    const image = await renderReceipt(item);

    console.log("[index] Processed item", 
        item, 
        `data:image/png;base64,${Buffer.from(image, "binary").toString("base64")}`);

    return image;
};

startTelegramBot({ onItemReceived }).then(() => {
    console.log("[index] Telegram module started");
});

startMeshCore({ onItemReceived }).then(() => {
    console.log("[index] MeshCore module started");
});
