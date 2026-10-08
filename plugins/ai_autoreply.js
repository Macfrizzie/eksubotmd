const { Module } = require('../core/handler');
const aiEngine = require('../core/aiEngine');

// 1. ACTIVE LISTENER FOR DIRECT MESSAGES (Knowledge Base Assistant)
Module({
    on: 'text',
    fromMe: false
}, async (m, text) => {
    try {
        // 🛑 CRITICAL: Never reply to messages sent by the owner or the bot itself
        if (m.fromMe || m.isOwner) return;

        const kb = aiEngine.getKB();
        if (!kb.enabled) return;

        // Skip commands
        const prefix = process.env.PREFIX || '.';
        if (text && text.trim().startsWith(prefix)) return;

        // DM only enforcement
        if (kb.dmOnly && m.isGroup) return;

        const clean = text.trim();
        if (!clean) return;

        // Typing presence simulation
        try {
            if (m.client?.sendPresenceUpdate) {
                await m.client.sendPresenceUpdate('composing', m.jid);
            }
        } catch (e) {}

        const senderName = m.pushName || 'Friend';
        const reply = await aiEngine.generateReply(clean, m.sender, senderName);

        if (reply) {
            // Natural brief typing pause
            await new Promise(r => setTimeout(r, 1200 + Math.random() * 1500));
            await m.reply(reply);
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

// 2. EXPLICIT COMMAND: .ai <prompt>
Module({
    pattern: "ai ?(.*)",
    fromMe: false,
    desc: "Ask the AI assistant with knowledge base",
    type: "general"
}, async (m, match) => {
    const query = match[1] || m.reply_message?.text;
    if (!query) {
        return m.reply("💡 Usage: .ai <your question>\nExample: .ai What services do you offer?");
    }

    try {
        await m.reply("🧠 Thinking...");
        const reply = await aiEngine.generateReply(query, m.sender, m.pushName, true);
        if (reply) {
            await m.reply(reply);
        } else {
            await m.reply("❌ Unable to generate a response at this moment.");
        }
    } catch (e) {
        m.reply(`❌ AI Error: ${e.message}`);
    }
});

// 3. TOGGLE AI COMMAND: .aitoggle
Module({
    pattern: "aitoggle",
    fromMe: true,
    desc: "Toggle AI Auto-Responder ON/OFF",
    type: "system"
}, async (m) => {
    const kb = aiEngine.getKB();
    const newState = !kb.enabled;
    aiEngine.saveKB({ enabled: newState });
    m.reply(`🤖 *AI Knowledge Responder:* ${newState ? '🟢 ENABLED' : '🔴 DISABLED'}`);
});
