const { Module } = require('../core/handler');
const { setVar } = require('../core/database');

Module({
    pattern: "setvar ?(.*)",
    fromMe: true,
    desc: "Set configuration",
    type: "system"  // <--- Added Type
}, async (m, match) => {
    if (!match[1] || !match[1].includes('=')) return m.reply("Usage: .setvar KEY=VALUE");
    const [key, ...val] = match[1].split('=');
    const value = val.join('=').trim();
    const cleanKey = key.trim().toUpperCase();
    await setVar(cleanKey, value);
    process.env[cleanKey] = value;
    await m.reply(`✅ *${cleanKey}* updated to: ${value}`);
});

Module({
    pattern: "mode ?(.*)",
    fromMe: true,
    desc: "Change bot mode",
    type: "system"  // <--- Added Type
}, async (m, match) => {
    const mode = match[1]?.toLowerCase().trim();
    if (mode !== 'public' && mode !== 'private') return m.reply(`Current: *${process.env.MODE || 'private'}*\nUse: .mode public / .mode private`);
    await setVar('MODE', mode);
    process.env.MODE = mode;
    await m.reply(`✅ Mode switched to *${mode}*`);
});

Module({
    pattern: "restart",
    fromMe: true,
    desc: "Restart the bot",
    type: "system"  // <--- Added Type
}, async (m) => {
    await m.reply("🔄 Restarting system...");
    process.exit(0);
});
