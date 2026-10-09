const { Module } = require('../core/handler');
const aiEngine = require('../core/aiEngine');
const analytics = require('../core/analytics');
const keywordEngine = require('../core/keywordEngine');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

function getGlobalOwnerJid(client) {
    const rawOwner = (process.env.OWNER_NUMBERS || process.env.SUDO || '').split(',')[0].replace(/[^0-9]/g, '');
    if (rawOwner) return rawOwner + '@s.whatsapp.net';
    if (client.user?.id) return jidNormalizedUser(client.user.id);
    return null;
}

// In-flight request tracker and per-sender debounce to protect API quotas
const inFlightSenders = new Set();
const lastSenderReplyTime = new Map();

// 1. ACTIVE TEXT LISTENER
Module({
    on: 'text',
    fromMe: false
}, async (m, text) => {
    try {
        if (m.fromMe) return;

        const clean = text ? text.trim() : '';
        if (!clean) return;

        // Skip command executions
        const prefix = process.env.PREFIX || '.';
        if (clean.startsWith(prefix)) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        const kwConfig = keywordEngine.getConfig();

        // If both Keyword Engine and AI are disabled, do nothing
        if (!kwConfig.enabled && !kb.enabled) return;

        // DM only enforcement (applies to AI and auto-replies)
        if (kb.dmOnly && m.isGroup) return;

        const senderName = (m.pushName && m.pushName !== 'User') ? m.pushName : (m.senderName || 'Friend');

        // 1. Preset Keyword Rule Engine (Zero latency, 0 token cost, instant reply)
        if (kwConfig.enabled) {
            const kwMatch = keywordEngine.findMatch(clean);
            if (kwMatch) {
                console.log(`🎯 [KeywordEngine] User ${m.sender} triggered rule '${kwMatch.id}' with query: "${clean}"`);
                const rawResponses = (Array.isArray(kwMatch.responses) && kwMatch.responses.length > 0)
                    ? kwMatch.responses
                    : [kwMatch.response || ''];

                // Send each response as a separate chat bubble in sequence!
                for (let i = 0; i < rawResponses.length; i++) {
                    const rawBubble = rawResponses[i];
                    if (!rawBubble || !rawBubble.trim()) continue;

                    let replyText = rawBubble
                        .replace(/@user/gi, senderName)
                        .replace(/@number/gi, m.sender.split('@')[0]);

                    // Simulate typing for each bubble
                    try {
                        if (m.client?.sendPresenceUpdate) {
                            await m.client.sendPresenceUpdate('composing', m.jid);
                        }
                    } catch (e) {}

                    // Delay between multiple chat bubbles
                    await new Promise(r => setTimeout(r, i === 0 ? 300 : 800));

                    try {
                        await m.reply(replyText);
                    } catch (replyErr) {
                        console.warn('⚠️ m.reply fallback triggered:', replyErr.message);
                        if (m.client?.sendMessage) {
                            await m.client.sendMessage(m.jid, { text: replyText });
                        }
                    }
                }

                try {
                    if (m.client?.sendPresenceUpdate) {
                        await m.client.sendPresenceUpdate('paused', m.jid);
                    }
                } catch (e) {}

                analytics.recordMessage(m.sender, true);
                return; // Handled by keyword rule! Do NOT invoke Gemini AI.
            }
        }

        // 2. Standalone Mode: If Keyword Engine is set to standalone, do NOT call AI!
        if (kwConfig.standalone) {
            return; // Only keyword rules respond in standalone mode
        }

        // 3. If AI is disabled in Hybrid mode, do not call AI
        if (!kb.enabled) return;

        // 4. Check if user is currently paused in Human Handoff mode
        if (aiEngine.isUserPaused(m.sender)) {
            return; // Let the human owner chat without AI interference
        }

        // 2. Debounce and Rate-Limiting Protection for AI API (Prevents 429 Quota Spikes)
        const now = Date.now();
        const lastReply = lastSenderReplyTime.get(m.sender) || 0;
        if (now - lastReply < 3000) {
            return; // Discard rapid-fire spam within 3 seconds
        }

        if (inFlightSenders.has(m.sender)) {
            return; // Already generating a reply for this user
        }

        inFlightSenders.add(m.sender);
        lastSenderReplyTime.set(m.sender, now);

        try {
            // Typing presence simulation
            try {
                if (m.client?.sendPresenceUpdate) {
                    await m.client.sendPresenceUpdate('composing', m.jid);
                }
            } catch (e) {}

            const result = await aiEngine.generateReply(clean, m.sender, senderName);

            if (result && result.reply) {
                try {
                    await m.reply(result.reply);
                } catch (replyErr) {
                    console.warn('⚠️ [AI AutoReply] m.reply fallback triggered:', replyErr.message);
                    if (m.client?.sendMessage) {
                        await m.client.sendMessage(m.jid, { text: result.reply });
                    }
                }
                analytics.recordMessage(m.sender, true);

                // Handle Smart Human Handoff Alert to Owner
                if (result.handoff) {
                    const ownerJid = getGlobalOwnerJid(m.client);
                    if (ownerJid) {
                        const cleanNumber = m.userPhone || m.sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                        const alertMsg = `🚨 *Smart Human Handoff Alert*\n\n` +
                            `👤 *User:* +${cleanNumber} (${senderName})\n` +
                            `❓ *Question:* "${result.handoff.query}"\n` +
                            `📝 *Reason:* ${result.handoff.reason}\n\n` +
                            `⏸️ _AI paused for this user._\n` +
                            `👉 *To resume:* Simply type *.airesume* directly inside their chat, or send:\n` +
                            `*.airesume ${cleanNumber}*`;

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
        } finally {
            inFlightSenders.delete(m.sender);
        }

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
        if (m.fromMe) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        const kwConfig = keywordEngine.getConfig();
        if (kwConfig.standalone || !kb.enabled) return;
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
        if (!audioBuffer) {
            await m.reply("⚠️ *Voice Note Notice:* Could not process the voice note. Please send your question as text.");
            return;
        }

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
                    const cleanNumber = (m.userPhone || m.sender.split('@')[0].split(':')[0]).replace(/[^0-9]/g, '');
                    const alertMsg = `🚨 *Smart Human Handoff Alert (Voice Note)*\n\n` +
                        `👤 *User:* @${cleanNumber} (${senderName})\n` +
                        `📝 *Reason:* ${result.handoff.reason}\n\n` +
                        `⏸️ _AI paused for this user._\n` +
                        `👉 *To resume:* Simply type *.airesume* directly inside their chat, or send:\n` +
                        `*.airesume ${cleanNumber}*`;

                    await m.client.sendMessage(ownerJid, { text: alertMsg, mentions: [m.sender] });
                }
            }
        }
    } catch (err) {
        console.error('Audio message listener error:', err.message);
    }
});

// 3. 🖼️ ACTIVE IMAGE / SCREENSHOT LISTENER
Module({
    on: 'imageMessage',
    fromMe: false
}, async (m) => {
    try {
        if (m.fromMe) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        const kwConfig = keywordEngine.getConfig();
        if (kwConfig.standalone || !kb.enabled) return;
        if (kb.dmOnly && m.isGroup) return;

        if (aiEngine.isUserPaused(m.sender)) return;

        const imgMsg = m.data?.message?.imageMessage;
        if (!imgMsg) return;

        // Visual indicator that bot is analyzing image
        try {
            await m.client.sendMessage(m.jid, { react: { text: "🔍", key: m.key } });
            if (m.client?.sendPresenceUpdate) {
                await m.client.sendPresenceUpdate('composing', m.jid);
            }
        } catch (e) {}

        const imageBuffer = await m.download();
        if (!imageBuffer) {
            await m.reply("⚠️ *Image Notice:* Could not process the uploaded image. Please try resending it or ask your question in text.");
            return;
        }

        const senderName = (m.pushName && m.pushName !== 'User') ? m.pushName : (m.senderName || 'Friend');
        const mimeType = imgMsg.mimetype || 'image/jpeg';
        const caption = m.text || imgMsg.caption || '';

        const result = await aiEngine.processImageMessage(imageBuffer, mimeType, caption, m.sender, senderName);

        if (result && result.reply) {
            await m.reply(result.reply);
            analytics.recordMessage(m.sender, true);
            try {
                await m.client.sendMessage(m.jid, { react: { text: "✅", key: m.key } });
            } catch (e) {}

            // Handoff alert if image inquiry needed human
            if (result.handoff) {
                const ownerJid = getGlobalOwnerJid(m.client);
                if (ownerJid) {
                    const cleanNumber = (m.userPhone || m.sender.split('@')[0].split(':')[0]).replace(/[^0-9]/g, '');
                    const alertMsg = `🚨 *Smart Human Handoff Alert (Image Inquiry)*\n\n` +
                        `👤 *User:* @${cleanNumber} (${senderName})\n` +
                        `📝 *Reason:* ${result.handoff.reason}\n\n` +
                        `⏸️ _AI paused for this user._\n` +
                        `👉 *To resume:* Simply type *.airesume* directly inside their chat, or send:\n` +
                        `*.airesume ${cleanNumber}*`;

                    await m.client.sendMessage(ownerJid, { text: alertMsg, mentions: [m.sender] });
                }
            }
        }
    } catch (err) {
        console.error('Image message listener error:', err.message);
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

// 4. SMART HANDOFF & RESUME: .airesume [user]
Module({
    pattern: "airesume ?(.*)",
    fromMe: true,
    desc: "Resume AI auto-replies for this chat, a specific user, or globally",
    type: "system"
}, async (m, match) => {
    let target = (match[1] || '').trim();

    // 0. If user typed ".airesume all", clear all paused chats!
    if (target.toLowerCase() === 'all') {
        aiEngine.clearAllHandoffs();
        aiEngine.saveKB({ enabled: true });
        return m.reply("🟢 *AI Auto-Replies Resumed for ALL Chats!*\nAll paused chats have been unpaused, and global AI is active.");
    }

    // 1. If quoted message, target the quoted user
    if (!target && m.reply_message?.sender) {
        target = m.reply_message.sender;
    }

    // 2. If typed directly inside a 1-on-1 private user chat, target this chat!
    const ownerJid = getGlobalOwnerJid(m.client);
    if (!target && !m.isGroup && m.jid && !m.jid.includes('status@broadcast')) {
        if (m.jid !== ownerJid) {
            target = m.jid;
        }
    }

    // 3. If a target chat/user was identified:
    if (target) {
        const cleanNumber = target.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const resumed = aiEngine.resumeAIForUser(target);
        if (resumed) {
            return m.reply(`✅ *AI Auto-Reply Resumed!*\nThe bot will now answer messages from this chat (+${cleanNumber}) automatically.`, {
                mentions: [target.includes('@') ? target : (cleanNumber + '@s.whatsapp.net')]
            });
        } else {
            aiEngine.saveKB({ enabled: true });
            return m.reply(`✅ *AI Active for this chat!*\nChat was not in paused state. AI auto-reply is ready and active.`);
        }
    }

    // 4. If sent with no args in group or owner note-to-self, resume globally
    aiEngine.saveKB({ enabled: true });
    return m.reply("🟢 *AI Auto-Responder Resumed Globally!*\nThe bot is now answering incoming WhatsApp messages using the Knowledge Base.\n\n_Tip:_ To unpause all individual chats, send *.airesume all*.");
});

// 5. SMART HANDOFF & PAUSE: .aipause [user]
Module({
    pattern: "aipause ?(.*)",
    fromMe: true,
    desc: "Pause AI auto-replies for this chat, a specific user, or globally",
    type: "system"
}, async (m, match) => {
    let target = (match[1] || '').trim();

    if (!target && m.reply_message?.sender) {
        target = m.reply_message.sender;
    }

    const ownerJid = getGlobalOwnerJid(m.client);
    if (!target && !m.isGroup && m.jid && !m.jid.includes('status@broadcast')) {
        if (m.jid !== ownerJid) {
            target = m.jid;
        }
    }

    if (target) {
        const cleanNumber = target.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const targetJid = target.includes('@') ? target : (cleanNumber + '@s.whatsapp.net');
        aiEngine.pauseAIForUser(targetJid, 'Manually paused by owner inside chat', 'Manual Chat', m.pushName || 'User');
        return m.reply(`⏸️ *AI Paused for this chat!*\nThe bot stopped auto-replying to +${cleanNumber}. You can chat manually.\n👉 Simply send *.airesume* inside this chat whenever you are done.`, {
            mentions: [targetJid]
        });
    }

    aiEngine.saveKB({ enabled: false });
    return m.reply("⏸️ *AI Auto-Responder Paused Globally!*\nThe bot has stopped replying to incoming messages.\nSend *.airesume* or *.aion* to reactivate anytime.");
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
