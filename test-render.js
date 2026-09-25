import { renderReceipt } from "./printer.js";

const image = await renderReceipt({
    text: "\u{1F97A}\u{1F49C}\u{1F98A}",
    // text: "Hello, you ^^\n\nSecond line :3",
    source: "telegram",
    from: "username",
    timestamp: Math.floor(Date.now() / 1000),
});

console.log(`data:image/png;base64,${Buffer.from(image, "binary").toString("base64")}`);