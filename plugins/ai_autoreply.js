const { Module } = require('../core/handler');
const aiEngine = require('../core/aiEngine');
const analytics = require('../core/analytics');
const keywordEngine = require('../core/keywordEngine');
const welcomeEngine = require('../core/welcomeEngine');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

function getGlobalOwnerJid(client) {
    const rawOwner = (process.env.OWNER_NUMBERS || process.env.SUDO || '').split(',')[0].replace(/[^0-9]/g, '');
    if (rawOwner) return rawOwner + '@s.whatsapp.net';
    if (client.user?.id) return jidNormalizedUser(client.user.id);
    return null;
}

// In-flight request tracker and per-sender message buffer for bundling rapid multi-messages/images
const inFlightSenders = new Set();
const senderBuffers = new Map(); // senderId -> { texts: [], images: [], lastM: m, timer: timeoutId }
const AGGREGATION_WINDOW_MS = 2500; // 2.5 seconds window to group multi-messages/images

// Handler to process the unified bundled messages/images for a user
async function processUnifiedBundle(senderId) {
    const bundle = senderBuffers.get(senderId);
    if (!bundle) return;
    senderBuffers.delete(senderId);

    const { texts, images, lastM } = bundle;
    const m = lastM;
    if (!m) return;

    // Check if user is currently paused in Human Handoff mode
    if (aiEngine.isUserPaused(senderId)) {
        return; // Silent: let the human owner chat without bot interference
    }

    const kb = aiEngine.getKB();
    const kwConfig = keywordEngine.getConfig();
    const senderName = (m.pushName && m.pushName !== 'User') ? m.pushName : (m.senderName || 'Friend');
    const userPhone = m.userPhone || senderId.split('@')[0];
    const unifiedText = texts.join('\n').trim();

    // 0. Explicit human / admin assistance request check
    const explicitHumanRegex = /^(talk to (human|admin|someone|an agent|person)|i want (human|admin)|let me talk to|speak (with|to) human|can i speak to (human|someone)|human please|admin please)/i;
    if (explicitHumanRegex.test(unifiedText)) {
        aiEngine.pauseAIForUser(senderId, "User explicitly requested human/admin assistance", unifiedText, senderName);
        const ownerJid = getGlobalOwnerJid(m.client);
        const cleanNumber = userPhone.replace(/[^0-9]/g, '');

        await m.reply("Sure! I have paused the AI and connected you to our representative. Please hold on, someone will attend to you shortly. 🙏");

        if (ownerJid) {
            const alertMsg = `🚨 *Human Representative Requested*\n\n` +
                `👤 *User:* +${cleanNumber} (${senderName})\n` +
                `❓ *Request:* "${unifiedText}"\n\n` +
                `⏸️ _AI is now paused for this chat._\n` +
                `👉 *To resume after you reply:* Type *.airesume* in their chat, or send:\n` +
                `*.airesume ${cleanNumber}*`;

            await m.client.sendMessage(ownerJid, { text: alertMsg, mentions: [senderId] });
        }
        return;
    }

    // 1. Keyword Rule Engine check (If text is present and matches a keyword rule)
    if (kwConfig.enabled && unifiedText) {
        const kwMatch = keywordEngine.findMatch(unifiedText);
        if (kwMatch) {
            console.log(`🎯 [KeywordEngine] User ${senderId} triggered rule '${kwMatch.id}' with bundle: "${unifiedText}"`);
            const rawResponses = (Array.isArray(kwMatch.responses) && kwMatch.responses.length > 0)
                ? kwMatch.responses
                : [kwMatch.response || ''];

            for (let i = 0; i < rawResponses.length; i++) {
                const rawBubble = rawResponses[i];
                if (!rawBubble || !rawBubble.trim()) continue;

                let replyText = rawBubble
                    .replace(/@user/gi, senderName)
                    .replace(/@number/gi, userPhone);

                try {
                    if (m.client?.sendPresenceUpdate) {
                        await m.client.sendPresenceUpdate('composing', m.jid);
                    }
                } catch (e) {}

                await new Promise(r => setTimeout(r, i === 0 ? 300 : 700));

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

            analytics.recordMessage(senderId, true);
            return;
        }
    }

    // 2. Standalone Mode check
    if (kwConfig.standalone) {
        return; // Only keyword rules respond in standalone mode
    }

    // 3. If AI is disabled in Hybrid mode
    if (!kb.enabled) return;

    if (inFlightSenders.has(senderId)) return;
    inFlightSenders.add(senderId);

    try {
        // Compose typing presence
        try {
            if (m.client?.sendPresenceUpdate) {
                await m.client.sendPresenceUpdate('composing', m.jid);
            }
        } catch (e) {}

        let result = null;

        // If bundled images exist, send to Gemini vision with all images + unified text
        if (images.length > 0) {
            result = await aiEngine.processImageMessage(images, 'image/jpeg', unifiedText, senderId, senderName);
        } else if (unifiedText) {
            result = await aiEngine.generateReply(unifiedText, senderId, senderName);
        }

        if (result && result.reply) {
            try {
                await m.reply(result.reply);
            } catch (replyErr) {
                console.warn('⚠️ [AI AutoReply] m.reply fallback triggered:', replyErr.message);
                if (m.client?.sendMessage) {
                    await m.client.sendMessage(m.jid, { text: result.reply });
                }
            }
            analytics.recordMessage(senderId, true);

            // Handle Smart Human Handoff Alert to Owner
            if (result.handoff) {
                // Ensure AI is paused for this user
                aiEngine.pauseAIForUser(senderId, result.handoff.reason, result.handoff.query || unifiedText, senderName);

                const ownerJid = getGlobalOwnerJid(m.client);
                if (ownerJid) {
                    const cleanNumber = userPhone.replace(/[^0-9]/g, '');
                    const alertMsg = `🚨 *Smart Human Handoff Alert*\n\n` +
                        `👤 *User:* +${cleanNumber} (${senderName})\n` +
                        `❓ *Question:* "${result.handoff.query || unifiedText}"\n` +
                        `📝 *Reason:* ${result.handoff.reason}\n\n` +
                        `⏸️ _AI paused for this user._\n` +
                        `👉 *To resume:* Simply type *.airesume* directly inside their chat, or send:\n` +
                        `*.airesume ${cleanNumber}*`;

                    await m.client.sendMessage(ownerJid, {
                        text: alertMsg,
                        mentions: [senderId]
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
        console.error('❌ Error processing unified bundle:', err.message);
    } finally {
        inFlightSenders.delete(senderId);
    }
}

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

        // If user is already paused in Human Handoff mode, do not process
        if (aiEngine.isUserPaused(m.sender)) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        const kwConfig = keywordEngine.getConfig();
        const senderName = (m.pushName && m.pushName !== 'User') ? m.pushName : (m.senderName || 'Friend');
        const userPhone = m.userPhone || m.sender.split('@')[0];

        // 0. FIRST-TIME USER WELCOME & CONTACT SAVER FLOW
        const welcomeConfig = welcomeEngine.getConfig();
        if (welcomeConfig.enabled) {
            const isEligibleChat = !welcomeConfig.dmOnly || !m.isGroup;
            if (isEligibleChat) {
                // Case A: User has received welcome message and is confirming with "saved"
                if (welcomeEngine.isAwaitingSave(m.sender)) {
                    if (welcomeEngine.isSaveTrigger(clean)) {
                        welcomeEngine.recordSaved(m.sender);
                        const confirmMsg = welcomeEngine.getSavedConfirmationMessage(senderName, userPhone);
                        if (confirmMsg) {
                            try {
                                if (m.client?.sendPresenceUpdate) await m.client.sendPresenceUpdate('composing', m.jid);
                            } catch (e) {}
                            await new Promise(r => setTimeout(r, 400));
                            await m.reply(confirmMsg);
                            try {
                                if (m.client?.sendPresenceUpdate) await m.client.sendPresenceUpdate('paused', m.jid);
                            } catch (e) {}
                            analytics.recordMessage(m.sender, true);
                            return;
                        }
                    } else if (welcomeConfig.requireSavedBeforeChat) {
                        const reminderMsg = `Kindly save this contact as *EKSU Bot* and reply *SAVED* to start chatting! 😊`;
                        await m.reply(reminderMsg);
                        return;
                    }
                }

                // Case B: Brand new user sending their very first message
                if (welcomeEngine.isFirstTimeUser(m.sender)) {
                    welcomeEngine.recordFirstWelcome(m.sender, senderName);
                    const welcomeMsg = welcomeEngine.getWelcomeMessage(senderName, userPhone);
                    if (welcomeMsg) {
                        try {
                            if (m.client?.sendPresenceUpdate) await m.client.sendPresenceUpdate('composing', m.jid);
                        } catch (e) {}
                        await new Promise(r => setTimeout(r, 500));
                        await m.reply(welcomeMsg);
                        try {
                            if (m.client?.sendPresenceUpdate) await m.client.sendPresenceUpdate('paused', m.jid);
                        } catch (e) {}
                        analytics.recordMessage(m.sender, true);
                        return;
                    }
                }
            }
        }

        // If both Keyword Engine and AI are disabled, do nothing
        if (!kwConfig.enabled && !kb.enabled) return;
        if (kb.dmOnly && m.isGroup) return;

        // Add text to the sender's debounce aggregation buffer
        let buf = senderBuffers.get(m.sender);
        if (!buf) {
            buf = { texts: [], images: [], lastM: m, timer: null };
            senderBuffers.set(m.sender, buf);
        }

        buf.texts.push(clean);
        buf.lastM = m;

        // Clear existing debounce timer and restart it for 2.5s window
        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
            processUnifiedBundle(m.sender);
        }, AGGREGATION_WINDOW_MS);

        // Show typing indicator during collection
        try {
            if (m.client?.sendPresenceUpdate) {
                m.client.sendPresenceUpdate('composing', m.jid).catch(() => {});
            }
        } catch (e) {}

    } catch (err) {
        console.error('AI Auto-reply text listener error:', err.message);
    }
});

// 2. 🎙️ ACTIVE VOICE NOTE / AUDIO LISTENER
Module({
    on: 'audioMessage',
    fromMe: false
}, async (m) => {
    try {
        if (m.fromMe) return;

        // If user is paused in Human Handoff mode, do not process
        if (aiEngine.isUserPaused(m.sender)) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        const kwConfig = keywordEngine.getConfig();
        if (kwConfig.standalone || !kb.enabled) return;
        if (kb.dmOnly && m.isGroup) return;

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
                aiEngine.pauseAIForUser(m.sender, result.handoff.reason, "Voice Note Audio Query", senderName);
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

// 3. 🖼️ ACTIVE IMAGE / SCREENSHOT LISTENER (Bundled with text/other images)
Module({
    on: 'imageMessage',
    fromMe: false
}, async (m) => {
    try {
        if (m.fromMe) return;

        // If user is paused in Human Handoff mode, do not process
        if (aiEngine.isUserPaused(m.sender)) return;

        analytics.recordMessage(m.sender, false);

        const kb = aiEngine.getKB();
        const kwConfig = keywordEngine.getConfig();
        if (kwConfig.standalone || !kb.enabled) return;
        if (kb.dmOnly && m.isGroup) return;

        const imgMsg = m.data?.message?.imageMessage;
        if (!imgMsg) return;

        // Quick reaction indicator
        try {
            await m.client.sendMessage(m.jid, { react: { text: "🔍", key: m.key } });
            if (m.client?.sendPresenceUpdate) {
                m.client.sendPresenceUpdate('composing', m.jid).catch(() => {});
            }
        } catch (e) {}

        const imageBuffer = await m.download();
        if (!imageBuffer) return;

        const mimeType = imgMsg.mimetype || 'image/jpeg';
        const caption = (m.text || imgMsg.caption || '').trim();

        // Bundle into senderBuffers
        let buf = senderBuffers.get(m.sender);
        if (!buf) {
            buf = { texts: [], images: [], lastM: m, timer: null };
            senderBuffers.set(m.sender, buf);
        }

        buf.images.push({ buffer: imageBuffer, mimeType });
        if (caption) {
            buf.texts.push(caption);
        }
        buf.lastM = m;

        // Reset debounce timer to group images/messages sent within 2.5 seconds
        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
            processUnifiedBundle(m.sender);
        }, AGGREGATION_WINDOW_MS);

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
