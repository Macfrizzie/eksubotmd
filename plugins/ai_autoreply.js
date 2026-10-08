const { Module } = require('../core/handler');
const aiEngine = require('../core/aiEngine');
const analytics = require('../core/analytics');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

function getGlobalOwnerJid(client) {
    const rawOwner = (process.env.OWNER_NUMBERS || process.env.SUDO || '').split(',')[0].replace(/[^0-9]/g, '');
    if (rawOwner) return rawOwner + '@s.whatsapp.net';
    if (client.user?.id) return jidNormalizedUser(client.user.id);
    return null;
}

// 1. ACTIVE TEXT LISTENER
Module({
    on: 'text',
    fromMe: false
}, async (m, text) => {
    try {
        if (m.fromMe || m.isOwner) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        if (!kb.enabled) return;

        // Skip commands
        const prefix = process.env.PREFIX || '.';
        if (text && text.trim().startsWith(prefix)) return;

        // DM only enforcement
        if (kb.dmOnly && m.isGroup) return;

        const clean = text.trim();
        if (!clean) return;

        // Check if user is currently paused in Human Handoff mode
        if (aiEngine.isUserPaused(m.sender)) {
            return; // Let the human owner chat without AI interference
        }

        // Typing presence simulation
        try {
            if (m.client?.sendPresenceUpdate) {
                await m.client.sendPresenceUpdate('composing', m.jid);
            }
        } catch (e) {}

        const senderName = (m.pushName && m.pushName !== 'User') ? m.pushName : (m.senderName || 'Friend');
        const result = await aiEngine.generateReply(clean, m.sender, senderName);

        if (result && result.reply) {
            await new Promise(r => setTimeout(r, 1200 + Math.random() * 1500));
            await m.reply(result.reply);
            analytics.recordMessage(m.sender, true);

            // Handle Smart Human Handoff Alert to Owner
            if (result.handoff) {
                const ownerJid = getGlobalOwnerJid(m.client);
                if (ownerJid) {
                    const alertMsg = `🚨 *Smart Human Handoff Alert*\n\n` +
                        `👤 *User:* @${m.sender.split('@')[0]} (${senderName})\n` +
                        `❓ *Question:* "${result.handoff.query}"\n` +
                        `📝 *Reason:* ${result.handoff.reason}\n\n` +
                        `⏸️ _AI paused for this user._\n` +
                        `👉 To resume AI after you reply, send:\n` +
                        `*.airesume ${m.sender.split('@')[0]}*`;

                    await m.client.sendMessage(ownerJid, {
                        text: alertMsg,
                        mentions: [m.sender]
                    });
                }
            }
        }

        try {
            if (m.client?.sendPresenceUpdate) {
                await m.client.sendPresenceUpdate('paused', m.jid);
            }
        } catch (e) {}

    } catch (err) {
        console.error('AI Auto-reply listener error:', err.message);
    }
});

// 2. 🎙️ ACTIVE VOICE NOTE / AUDIO LISTENER
Module({
    on: 'audioMessage',
    fromMe: false
}, async (m) => {
    try {
        if (m.fromMe || m.isOwner) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        if (!kb.enabled) return;
        if (kb.dmOnly && m.isGroup) return;

        if (aiEngine.isUserPaused(m.sender)) return;

        const audioMsg = m.data?.message?.audioMessage;
        if (!audioMsg) return;

        // Visual indicator that bot is listening/processing
        try {
            await m.client.sendMessage(m.jid, { react: { text: "🎧", key: m.key } });
            if (m.client?.sendPresenceUpdate) {
                await m.client.sendPresenceUpdate('recording', m.jid);
            }
        } catch (e) {}

        const audioBuffer = await m.download();
        if (!audioBuffer) return;

        const senderName = (m.pushName && m.pushName !== 'User') ? m.pushName : (m.senderName || 'Friend');
        const mimeType = audioMsg.mimetype || 'audio/ogg; codecs=opus';

        const result = await aiEngine.processVoiceNote(audioBuffer, mimeType, m.sender, senderName);

        if (result && result.reply) {
            await m.reply(result.reply);
            analytics.recordMessage(m.sender, true);
            try {
                await m.client.sendMessage(m.jid, { react: { text: "✅", key: m.key } });
            } catch (e) {}

            // Handoff alert if audio needed human
            if (result.handoff) {
                const ownerJid = getGlobalOwnerJid(m.client);
                if (ownerJid) {
                    const alertMsg = `🚨 *Smart Human Handoff Alert (Voice Note)*\n\n` +
                        `👤 *User:* @${m.sender.split('@')[0]} (${senderName})\n` +
                        `📝 *Reason:* ${result.handoff.reason}\n\n` +
                        `⏸️ _AI paused for this user._\n` +
                        `👉 To resume AI, send:\n` +
                        `*.airesume ${m.sender.split('@')[0]}*`;

                    await m.client.sendMessage(ownerJid, { text: alertMsg, mentions: [m.sender] });
                }
            }
        }
    } catch (err) {
        console.error('Audio message listener error:', err.message);
    }
});

// 3. EXPLICIT COMMAND: .ai <prompt>
Module({
    pattern: "ai ?(.*)",
    fromMe: false,
    desc: "Ask the AI assistant with knowledge base",
    type: "general"
}, async (m, match) => {
    const query = match[1] || m.reply_message?.text;
    if (!query) return m.reply("💡 Usage: .ai <your question>\nExample: .ai What services do you offer?");

    try {
        await m.reply("🧠 Thinking...");
        const result = await aiEngine.generateReply(query, m.sender, m.pushName, true);
        if (result && result.reply) {
            await m.reply(result.reply);
        } else {
            await m.reply("❌ Unable to generate a response at this moment.");
        }
    } catch (e) {
        m.reply(`❌ AI Error: ${e.message}`);
    }
});

// 4. SMART HANDOFF & GLOBAL RESUME: .airesume [user]
Module({
    pattern: "airesume ?(.*)",
    fromMe: true,
    desc: "Resume AI auto-replies (globally or for a specific user)",
    type: "system"
}, async (m, match) => {
    const input = match[1] || m.reply_message?.sender;
    if (!input || !input.trim()) {
        aiEngine.saveKB({ enabled: true });
        return m.reply("🟢 *AI Auto-Responder Resumed Globally!*\nThe bot is now answering incoming WhatsApp messages using the Knowledge Base.");
    }

    const clean = input.replace(/[^0-9]/g, '');
    const targetJid = clean + '@s.whatsapp.net';

    const resumed = aiEngine.resumeAIForUser(targetJid);
    if (resumed) {
        m.reply(`✅ *AI Resumed*: The bot will now answer messages from @${clean} automatically.`, { mentions: [targetJid] });
    } else {
        m.reply(`ℹ️ User @${clean} was not paused in Human Handoff mode.`, { mentions: [targetJid] });
    }
});

// 5. SMART HANDOFF & GLOBAL PAUSE: .aipause [user]
Module({
    pattern: "aipause ?(.*)",
    fromMe: true,
    desc: "Pause AI auto-replies (globally or for a specific user)",
    type: "system"
}, async (m, match) => {
    const input = match[1] || m.reply_message?.sender;
    if (!input || !input.trim()) {
        aiEngine.saveKB({ enabled: false });
        return m.reply("⏸️ *AI Auto-Responder Paused Globally!*\nThe bot has stopped replying to incoming messages.\nSend *.airesume* or *.aion* to reactivate anytime.");
    }

    const clean = input.replace(/[^0-9]/g, '');
    const targetJid = clean + '@s.whatsapp.net';

    aiEngine.pauseAIForUser(targetJid, 'Manually paused by owner', 'Manual Chat', 'User');
    m.reply(`⏸️ *AI Paused*: AI auto-replies are paused for @${clean}. You can chat manually.\nSend *.airesume ${clean}* when finished.`, { mentions: [targetJid] });
});

// 6. VIEW ACTIVE HANDOFFS: .aihandoffs
Module({
    pattern: "aihandoffs",
    fromMe: true,
    desc: "List users waiting for human support",
    type: "system"
}, async (m) => {
    const list = aiEngine.getHandoffList();
    if (list.length === 0) return m.reply("✅ No users currently waiting for human assistance.");

    let text = `📋 *Active Human Handoff Queue (${list.length}):*\n\n`;
    list.forEach((item, idx) => {
        text += `${idx + 1}. 👤 @${item.userPhone}\n   ❓ Inquiry: ${item.query || 'N/A'}\n   📝 Reason: ${item.reason}\n   👉 Resume: .airesume ${item.userPhone}\n\n`;
    });
    m.reply(text, { mentions: list.map(l => l.id) });
});

// 7. TOGGLE AI COMMAND: .aitoggle, .aion, .aioff
Module({
    pattern: "aitoggle",
    fromMe: true,
    desc: "Toggle AI Auto-Responder ON/OFF",
    type: "system"
}, async (m) => {
    const kb = aiEngine.getKB();
    const newState = !kb.enabled;
    aiEngine.saveKB({ enabled: newState });
    m.reply(`🤖 *AI Knowledge Responder:* ${newState ? '🟢 ENABLED' : '🔴 PAUSED / DISABLED'}`);
});

Module({
    pattern: "aion",
    fromMe: true,
    desc: "Turn AI Auto-Responder ON",
    type: "system"
}, async (m) => {
    aiEngine.saveKB({ enabled: true });
    m.reply("🟢 *AI Auto-Responder is now ACTIVE!*");
});

Module({
    pattern: "aioff",
    fromMe: true,
    desc: "Turn AI Auto-Responder OFF (Pause)",
    type: "system"
}, async (m) => {
    aiEngine.saveKB({ enabled: false });
    m.reply("🔴 *AI Auto-Responder is now PAUSED!*");
});
