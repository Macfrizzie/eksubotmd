const { Module } = require('../core/handler');

Module({
    pattern: "test",
    fromMe: false,
    desc: "Test command",
    type: "general"
}, async (message, match) => {
    await message.reply("Test successful!");
});

Module({
    on: "text",
    fromMe: false
}, async (message, text) => {
    if (text && text.includes("badword")) {
        await message.reply("Do not use bad words!");
    }
});
