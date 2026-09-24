import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.log("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
}

// Create a bot object
const bot = new Bot(token);

bot.command("start", async (ctx) => {
    console.log("Got start command");
});

// Register listeners to handle messages
bot.on("message", async (ctx) => {
    console.log(ctx.message);

    if (ctx.message.text) {
        ctx.reply("Echo: " + ctx.message.text);
    }
});

// Start the bot (using long polling)
bot.start();
