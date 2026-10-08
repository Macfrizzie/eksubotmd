const { Module } = require('../core/handler');
const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { getVar, setVar } = require('../core/database');

// --- HELPER: DEEP SEARCH ---
function findViewOnceMedia(msg) {
    if (!msg) return null;
    if (msg.imageMessage) return { type: 'imageMessage', content: msg.imageMessage };
    if (msg.videoMessage) return { type: 'videoMessage', content: msg.videoMessage };

    const wrappers = [
        'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
        'ephemeralMessage', 'documentWithCaptionMessage', 
        'message', 'containerMessage'
    ];

    for (const wrapper of wrappers) {
        if (msg[wrapper]) {
            const deep = findViewOnceMedia(msg[wrapper].message || msg[wrapper]);
            if (deep) return deep;
        }
    }
    return null;
}

// --- HELPER: GET CLEAN OWNER JID ---
function getGlobalOwner(client) {
    // Get SUDO from env
    let sudo = (process.env.SUDO || '').split(',')[0];
    // Remove all symbols (spaces, +, -) to prevent errors
    sudo = sudo.replace(/[^0-9]/g, '');
    
    // If no SUDO, return the bot's own number (Saved Messages)
    if (!sudo) return jidNormalizedUser(client.user.id);
    return sudo + '@s.whatsapp.net';
}

// 1. SETUP COMMAND
Module({
    pattern: "antiviewonce ?(.*)",
    fromMe: true,
    desc: "Manage ViewOnce Auto-Saver",
    type: "security"
}, async (m, match) => {
    const cmd = match[1]?.toLowerCase().trim();
    const validModes = ['group', 'pc', 'both', 'off'];

    if (!validModes.includes(cmd)) {
        const current = await getVar('ANTIVIEWONCE') || 'off';
        return m.reply(
            `🕵️ *ViewOnce Manager*\n\n` +
            `Current Mode: *${current.toUpperCase()}*\n` +
            `*Usage:*\n` +
            `• .antiviewonce group (Auto-save from groups)\n` +
            `• .antiviewonce pc (Auto-save from DMs)\n` +
            `• .antiviewonce both (Auto-save everything)\n` +
            `• .antiviewonce off`
        );
    }

    await setVar('ANTIVIEWONCE', cmd);
    m.reply(`✅ Anti-ViewOnce set to: *${cmd.toUpperCase()}*`);
});

// 2. AUTO-LISTENER (Background Saver)
Module({
    on: "message", // Changed from 'text' to 'message' to catch captionless media
    fromMe: false
}, async (m) => {
    // A. Check Mode
    const mode = await getVar('ANTIVIEWONCE');
    if (!mode || mode === 'off') return;

    if (mode === 'pc' && m.isGroup) return;     
    if (mode === 'group' && !m.isGroup) return; 

    // B. Check Message Content
    const fullMsg = m.data?.message;
    if (!fullMsg) return;

    // Strict Check: Is it a ViewOnce?
    const isViewOnce = fullMsg.viewOnceMessage || fullMsg.viewOnceMessageV2 || fullMsg.viewOnceMessageV2Extension || (fullMsg.ephemeralMessage?.message?.viewOnceMessage);
    if (!isViewOnce) return;

    const media = findViewOnceMedia(fullMsg);
    if (!media) return;

    try {
        // C. Download
        const buffer = await downloadMediaMessage(
            { key: m.key, message: fullMsg },
            'buffer', {}, { logger: console }
        );

        if (!buffer) return;

        // D. Send to Global Owner (Auto-save always goes to Owner)
        const target = getGlobalOwner(m.client);

        const caption = `🕵️ *Auto-Recovered*\n` +
                        `👤 @${m.sender.split('@')[0]} (${m.isGroup ? 'Group' : 'PC'})\n` +
                        `📝 ${media.content.caption || 'No Caption'}`;

        await m.client.sendMessage(target, { 
            [media.type === 'imageMessage' ? 'image' : 'video']: buffer, 
            caption: caption,
            mentions: [m.sender]
        });
        
    } catch (e) {
        console.error("Auto-AVO Error:", e);
    }
});

// 3. EMOJI TRIGGER (Manual Steal - No Reaction)
Module({
    on: "text",
    fromMe: true // Allow Owner/Bot to trigger
}, async (m, text) => {
    if (!m.reply_message) return;

    // Check for exactly 2 emojis (Allowing spaces)
    const cleanText = text.trim();
    // This regex ensures the message contains ONLY emojis/spaces and is short
    const isEmoji = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(cleanText) && cleanText.length < 10;
    
    // Check Permission
    const sudoList = (process.env.SUDO || '').split(',').map(s => s.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const isOwner = m.key.fromMe || sudoList.includes(m.sender);

    if (!isEmoji || !isOwner) return;

    const fullMsg = m.reply_message.data?.message;
    if (!fullMsg) return;

    const media = findViewOnceMedia(fullMsg);
    // Only work on ViewOnce
    const isViewOnceWrapper = fullMsg.viewOnceMessage || fullMsg.viewOnceMessageV2 || fullMsg.viewOnceMessageV2Extension || (fullMsg.ephemeralMessage?.message?.viewOnceMessage);
    
    if (!media || !isViewOnceWrapper) return;

    try {
        // REMOVED REACTION HERE as requested
        
        const buffer = await downloadMediaMessage(
            { key: m.reply_message.data.key, message: fullMsg },
            'buffer', {}, { logger: console }
        );

        // Send to THE PERSON WHO TRIGGERED IT (m.sender)
        // If Bot triggers it, it goes to Saved Messages
        const target = m.sender; 

        await m.client.sendMessage(target, { 
            [media.type === 'imageMessage' ? 'image' : 'video']: buffer, 
            caption: `🕵️ *Stealth Recovered*\nTarget: @${m.reply_message.sender.split('@')[0]}`,
            mentions: [m.reply_message.sender]
        });

    } catch (e) {
        console.error("Emoji Steal Error:", e);
    }
});

// 4. COMMAND .vv (Backup)
Module({
    pattern: "vv",
    fromMe: false,
    desc: "Manual recover",
    type: "tools"
}, async (m) => {
    if (!m.reply_message) return m.reply("❌ Reply to ViewOnce.");
    
    try {
        const fullMsg = m.reply_message.data?.message;
        const media = findViewOnceMedia(fullMsg);
        if (!media) return m.reply("❌ Not a ViewOnce.");

        const buffer = await downloadMediaMessage(
            { key: m.reply_message.data.key, message: fullMsg },
            'buffer', {}, { logger: console }
        );

        await m.client.sendMessage(m.jid, { 
            [media.type === 'imageMessage' ? 'image' : 'video']: buffer, 
            caption: "🔓 *Recovered*",
            mentions: [m.sender]
        }, { quoted: m });

    } catch (e) {
        m.reply("❌ Failed.");
    }
});
