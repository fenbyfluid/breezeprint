import { Bot } from "grammy";

async function downloadFile(bot, fileId) {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
        throw new Error(`Telegram did not return a path for file ${fileId}`);
    }

    const response = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
    if (!response.ok) {
        throw new Error(`Failed to download Telegram file ${fileId}: HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

function logMessage(message) {
    const from = message.from?.username ?? message.from?.id;
    if (message.text) {
        console.log(`[telegram] [${message.chat.type}] [text] ${from}: ${message.text}`);
    } else if (message.sticker) {
        console.log(`[telegram] [${message.chat.type}] [sticker] ${from}: ${message.sticker.emoji ?? ""} (${message.sticker.file_id})`);
    } else if (message.photo) {
        console.log(`[telegram] [${message.chat.type}] [photo] ${from}: ${message.photo.length} size(s), largest ${message.photo.at(-1).file_id}`);
    } else {
        console.log(`[telegram] [${message.chat.type}] [unknown] ${from}:`, message);
    }
}

async function toReceiptItem(bot, message) {
    const source = "telegram";
    const from = message.from?.username ?? message.from?.id;

    if (message.text) {
        return { source, from, type: "text", text: message.text };
    }

    // Animated/video stickers can't be printed, fall back to their static thumbnail
    if (message.sticker) {
        const sticker = message.sticker;
        const requiresThumbnail = sticker.is_animated || sticker.is_video || sticker.type !== "regular";
        const fileId = requiresThumbnail ? sticker.thumbnail?.file_id : sticker.file_id;
        if (!fileId) {
            return null;
        }

        return { source, from, type: "image", data: await downloadFile(bot, fileId) };
    }

    // Photos are provided in ascending size order, take the largest
    if (message.photo) {
        const fileId = message.photo.at(-1).file_id;
        if (!fileId) {
            return null;
        }

        return { source, from, type: "image", data: await downloadFile(bot, fileId) };
    }

    return null;
}

export async function startTelegramBot({ onItemReceived } = {}) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.warn("[telegram] TELEGRAM_BOT_TOKEN not set; skipping Telegram startup.");
        return null;
    }

    // Create a bot object
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

    // Handle the start command explicitly as it's the first interaction with the bot
    bot.command("start", async (ctx) => {
        await ctx.reply("Welcome! Send me text, stickers, or images to print them.");
    });

    // Handle incoming messages from users
    // TODO: Validate callback for inline interactions
    bot.on("message", async (ctx) => {
        logMessage(ctx.message);

        // Albums arrive as multiple messages sharing a media_group_id - handled individually for now
        const item = await toReceiptItem(bot, ctx.message);
        if (!item) {
            await ctx.reply("Sorry, I don't know how to print that type of message yet.");
            return;
        }

        let image = await onItemReceived(item);

        await ctx.reply("TODO");
    });

    bot.catch((err) => {
        console.error("[telegram] bot error:", err);
    });

    bot.start().then(() => {
        console.log("[telegram] bot stopped polling");
    });
}
