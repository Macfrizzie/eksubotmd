const { Module } = require('../core/handler');

// Word-boundary trigger regex to prevent false positives like "first", "best", "just", etc.
const TRIGGER_REGEX = /\b(save|send|snt|forward|status)\b/i;

// Per-sender cooldown (10 minutes) to prevent automated status scraping abuse
const statusCooldown = new Map();
const STATUS_COOLDOWN_MS = 10 * 60 * 1000;

Module({
    on: 'text', 
    fromMe: false 
}, async (m, text) => {
    try {
        // 1. It must be a reply
        if (!m.reply_message) return;

        // 2. It must be a reply to a STATUS
        const context = m.data?.message?.extendedTextMessage?.contextInfo;
        if (context?.remoteJid !== 'status@broadcast') return;

        // 3. Strict word-boundary keyword check
        if (!TRIGGER_REGEX.test(text || '')) return;

        // 4. Check Cooldown
        const lastRequested = statusCooldown.get(m.sender) || 0;
        if (Date.now() - lastRequested < STATUS_COOLDOWN_MS) {
            return; // Silently ignore repeated requests within cooldown
        }
        statusCooldown.set(m.sender, Date.now());

        // 5. React to show acknowledgment
        try {
            await m.client.sendMessage(m.jid, { react: { text: "⬇️", key: m.key } });
        } catch (e) {}

        // --- SCENARIO A: Text Status ---
        if (m.reply_message.text && !m.reply_message.image && !m.reply_message.video) {
            await m.client.sendMessage(m.jid, { 
                text: m.reply_message.text 
            }, { quoted: m });
            try {
                await m.client.sendMessage(m.jid, { react: { text: "✅", key: m.key } });
            } catch (e) {}
            return;
        }

        // --- SCENARIO B: Media Status (Photo/Video) ---
        const buffer = await m.reply_message.download();
        if (!buffer) {
            return m.reply("❌ Failed to fetch media from status.");
        }

        const type = m.reply_message.image ? 'image' : 'video';
        
        await m.client.sendMessage(m.jid, { 
            [type]: buffer, 
            caption: m.reply_message.caption || "" 
        }, { quoted: m });

        try {
            await m.client.sendMessage(m.jid, { react: { text: "✅", key: m.key } });
        } catch (e) {}

    } catch (e) {
        console.error("Status Reply Error:", e.message);
    }
});
