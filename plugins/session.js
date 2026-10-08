const { Module } = require('../core/handler');
const { encodeSession } = require('../core/sessionManager');
const path = require('path');
const fs = require('fs');

Module({
    pattern: "session",
    fromMe: true,
    desc: "Generate or regenerate SESSION_ID",
    type: "system"
}, async (m) => {
    try {
        const sessionFolder = path.join(__dirname, '../session');
        
        if (!fs.existsSync(sessionFolder) || fs.readdirSync(sessionFolder).length === 0) {
            return await m.reply('❌ No active session files found. Please connect the bot first.');
        }

        await m.reply('🔐 Packaging and encoding SESSION_ID...');
        
        const sessionId = await encodeSession(sessionFolder);
        
        let message = '╭━━━『 SESSION ID 』━━━╮\n\n';
        message += '📋 Copy this string to your .env file:\n\n';
        message += `\`\`\`SESSION_ID=${sessionId}\`\`\`\n\n`;
        message += '⚠️ *SECURITY NOTICE:*\n';
        message += '• Keep this ID strictly confidential\n';
        message += '• Do not share in public repositories or chats\n';
        message += '• Contains your full WhatsApp login keys\n\n';
        message += '╰━━━━━━━━━━━━━━━━╯';
        
        await m.reply(message);
        
    } catch (error) {
        console.error('Session generation error:', error.message);
        await m.reply(`❌ Failed to generate SESSION_ID: ${error.message}`);
    }
});