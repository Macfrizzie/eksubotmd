const { Module } = require('../core/handler');

Module({
    pattern: "ping",
    fromMe: false,
    desc: "Check bot response time",
    type: "general"
}, async (m) => {
    const start = Date.now();
    await m.reply('🏓 Pinging...');
    const end = Date.now();
    const ping = end - start;
    await m.reply(`🏓 *Pong!*\n⚡ Response latency: ${ping}ms`);
});