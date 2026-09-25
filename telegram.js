import { Bot } from "grammy";

if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
}

// Create a bot object
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Handle the start command explicitly as it's the first interaction with the bot
bot.command("start", async (ctx) => {
    await ctx.reply("Welcome! Send me text, stickers, or images to print them.");
});

// A run of only emoji (and joiners/variation selectors) is rendered large by Telegram clients
// TODO: We're actually going to make this the responsibility of the rendering side
const EMOJI_ONLY_REGEX = /^(\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u;

// Logs a compact one-line summary of a message, tailored to its type
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

// Normalizes a message into an item ready for hand-off to the receipt renderer, or null if unsupported
function toReceiptItem(message) {
    const source = "telegram";
    const from = message.from?.username ?? message.from?.id;

    if (message.text) {
        return { source, from, type: "text", text: message.text };
    }

    // Animated/video stickers can't be printed, fall back to their static thumbnail
    if (message.sticker) {
        return { source, from, type: "image", fileId: message.sticker.thumbnail?.file_id ?? message.sticker.file_id };
    }

    // Photos are provided in ascending size order, take the largest
    if (message.photo) {
        return { source, from, type: "image", fileId: message.photo.at(-1).file_id };
    }

    return null;
}

// Handle incoming messages from users
// TODO: Validate callback for inline interactions
bot.on("message", async (ctx) => {
    logMessage(ctx.message);

    // Albums arrive as multiple messages sharing a media_group_id - handled individually for now
    const item = toReceiptItem(ctx.message);
    if (!item) {
        await ctx.reply("Sorry, I don't know how to print that type of message yet.");
        return;
    }

    // TODO: Hand off `item` to the receipt rendering logic
    console.log(item);

    await ctx.reply("TODO");
});

// Start the bot (using long polling)
bot.start();
