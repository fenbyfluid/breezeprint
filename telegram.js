import { Bot, InputFile } from "grammy";
import { paperEvents } from "./printer.js";

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

export function telegramSenderName(user) {
    const displayName = [user?.first_name, user?.last_name]
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.trim())
        .join(" ");
    const senderId = user?.username ? `@${user.username}` : String(user?.id ?? "Unknown");
    return `${senderId} \u00b7 ${displayName || "Unknown"}`;
}

function logMessage(message) {
    const from = telegramSenderName(message.from);
    if (message.text) {
        console.log(`[telegram] [${message.chat.type}] [text] ${from}: ${message.text}`);
    } else if (message.sticker) {
        console.log(`[telegram] [${message.chat.type}] [sticker] ${from}: ${message.sticker.emoji ?? ""} (${message.sticker.file_id})`);
    } else if (message.photo) {
        console.log(`[telegram] [${message.chat.type}] [photo] ${from}: ${message.photo.length} size(s), largest ${message.photo.at(-1).file_id}${message.caption ? `, caption: ${message.caption}` : ""}`);
    } else if (message.document) {
        console.log(`[telegram] [${message.chat.type}] [document] ${from}: ${message.document.mime_type ?? "unknown type"} ${message.document.file_name ?? ""}${message.caption ? `, caption: ${message.caption}` : ""}`);
    } else {
        console.log(`[telegram] [${message.chat.type}] [unknown] ${from}:`, message);
    }
}

// The printer has no italic, strikethrough or spoiler, so they borrow the nearest style
const ENTITY_STYLES = {
    bold: "bold",
    italic: "bold",
    underline: "underline",
    strikethrough: "underline",
    spoiler: "invert",
};

// Entity offsets are in UTF-16 code units, matching JS string indices
export function toTextSegments(text, entities = []) {
    const styled = entities.filter((entity) => ENTITY_STYLES[entity.type]);
    if (!styled.length) {
        return text;
    }

    const cuts = [...new Set([0, text.length, ...styled.flatMap(({ offset, length }) => [offset, offset + length])])]
        .filter((cut) => cut >= 0 && cut <= text.length)
        .sort((a, b) => a - b);

    const segments = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const [start, end] = [cuts[i], cuts[i + 1]];
        const style = {};
        for (const entity of styled) {
            if (entity.offset <= start && entity.offset + entity.length >= end) {
                style[ENTITY_STYLES[entity.type]] = true;
            }
        }

        const previous = segments.at(-1);
        const sameStyle = previous && ["bold", "underline", "invert"].every((key) => Boolean(previous[key]) === Boolean(style[key]));
        if (sameStyle) {
            previous.text += text.slice(start, end);
        } else {
            segments.push({ text: text.slice(start, end), ...style });
        }
    }

    return segments;
}

async function toReceiptItem(bot, message) {
    const source = "telegram";
    const from = telegramSenderName(message.from);
    const timestamp = message.date;

    if (message.text) {
        return { source, from, text: toTextSegments(message.text, message.entities), timestamp };
    }

    // Animated/video stickers can't be printed, fall back to their static thumbnail
    if (message.sticker) {
        const sticker = message.sticker;
        const requiresThumbnail = sticker.is_animated || sticker.is_video || sticker.type !== "regular";
        const fileId = requiresThumbnail ? sticker.thumbnail?.file_id : sticker.file_id;
        if (!fileId) {
            return null;
        }

        return { source, from, image: await downloadFile(bot, fileId), timestamp };
    }

    // Photos are provided in ascending size order, take the largest
    if (message.photo) {
        const fileId = message.photo.at(-1).file_id;
        if (!fileId) {
            return null;
        }

        return { source, from, image: await downloadFile(bot, fileId), text: toTextSegments(message.caption, message.caption_entities), timestamp };
    }

    // Images sent as files arrive uncompressed
    if (message.document?.mime_type?.startsWith("image/")) {
        return { source, from, image: await downloadFile(bot, message.document.file_id), text: toTextSegments(message.caption, message.caption_entities), timestamp };
    }

    return null;
}

export async function startTelegramBot({ token, onItemReceived } = {}) {
    // Create a bot object
    const bot = new Bot(token);

    // Printed messages received since the paper was last taken
    let pendingMessages = [];
    paperEvents.on("taken", async () => {
        const messages = pendingMessages;
        pendingMessages = [];

        const results = await Promise.allSettled(messages.map(({ chatId, messageId }) => {
            return bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👀" }]);
        }));

        results.forEach((result) => {
            if (result.status === "rejected") {
                console.warn("[telegram] Failed to react to message:", result.reason?.message ?? result.reason);
            }
        });
    });

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
            await ctx.reply("Sorry, I don't know how to print that type of message yet.", {
                disable_notification: true,
                reply_parameters: {
                    message_id: ctx.message.message_id,
                },
            });
            
            return;
        }

        await ctx.replyWithDraft("Working on it!", {
            can_stop: false,
        });

        const { image, printError } = await onItemReceived(item);

        if (!printError) {
            pendingMessages.push({ chatId: ctx.message.chat.id, messageId: ctx.message.message_id });
        }

        // The image is still produced when the printer itself fails
        await ctx.replyWithPhoto(new InputFile(image, "receipt.png"), {
            caption: printError ? `Warning: Not printed (${printError.message})` : undefined,
            disable_notification: true,
            reply_parameters: {
                message_id: ctx.message.message_id,
            },
        });
    });

    bot.catch((err) => {
        console.error("[telegram] bot error:", err);
    });

    bot.start().then(() => {
        console.log("[telegram] bot stopped polling");
    });
}
