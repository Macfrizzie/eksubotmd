const { Module, commands } = require('../core/handler');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

Module({
    pattern: "menu",
    fromMe: false,
    desc: "Show All Commands",
    type: "general"
}, async (m) => {
    // 1. Define Categories (Order matters!)
    const categories = ["general", "group", "security", "system", "tools", "fun"];
    let menuText = `╭━━━〔 *Eksu-MD* 〕━━━┈\n`;
    menuText += `┃ 👤 *User:* ${m.pushName}\n`;
    menuText += `┃ 🔒 *Mode:* ${process.env.MODE || 'private'}\n`;
    menuText += `┃ 🧩 *Commands:* ${commands.length}\n`;
    menuText += `╰━━━━━━━━━━━━━━━━━━┈\n\n`;

    // 2. Loop through Categories
    const categoryMap = {};

    // Sort commands into buckets
    commands.forEach(cmd => {
        if (!cmd.pattern) return; // Skip listeners
        const type = cmd.type || "others"; // Default to 'others' if no type
        if (!categoryMap[type]) categoryMap[type] = [];
        categoryMap[type].push(cmd.cmdName);
    });

    // 3. Build the Menu String
    // First, print the known categories in order
    for (const category of categories) {
        if (categoryMap[category] && categoryMap[category].length > 0) {
            menuText += `┌───〔 *${category.toUpperCase()}* 〕───\n`;
            categoryMap[category].sort().forEach(cmd => {
                menuText += `│ ◦ .${cmd}\n`;
            });
            menuText += `└───────────────┈\n\n`;
            delete categoryMap[category]; // Remove processed category
        }
    }

    // Then, print anything left over (like "others")
    for (const key in categoryMap) {
        if (categoryMap[key].length > 0) {
            menuText += `┌───〔 *${key.toUpperCase()}* 〕───\n`;
            categoryMap[key].sort().forEach(cmd => {
                menuText += `│ ◦ .${cmd}\n`;
            });
            menuText += `└───────────────┈\n\n`;
        }
    }

    menuText += `_Powered by Eksu-MD_`;

    // 4. Send with Image (Optional) or Text
    // Using simple text reply for speed
    await m.reply(menuText);
});
