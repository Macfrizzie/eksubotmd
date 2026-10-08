const { Module } = require('../core/handler');
const { getVar, setVar } = require('../core/database');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// --- 1. INTERNAL MEMORY (Replaces Broken Store) ---
// We create a simple map to save messages manually
const messageHistory = new Map();

// Helper: Save message
function saveMessage(m) {
    if (!m || !m.key || !m.key.id) return;
    // Save the message
    messageHistory.set(m.key.id, m);
    
    // Auto-delete from memory after 5 minutes (to save RAM)
    setTimeout(() => {
        messageHistory.delete(m.key.id);
    }, 5 * 60 * 1000);
}

// Helper: Get Sudo Number
function getGlobalOwner(client) {
    let sudo = (process.env.SUDO || '').split(',')[0];
    sudo = sudo.replace(/[^0-9]/g, '');
    if (!sudo) return jidNormalizedUser(client.user.id);
    return sudo + '@s.whatsapp.net';
}

// --- 2. MESSAGE SAVER (The Recorder) ---
// This listens to every message and saves it to our internal memory
Module({
    on: 'message', 
    fromMe: false
}, async (m) => {
    // We save the raw message object so we can forward it later
    saveMessage(m);
});

// --- 3. MANAGER COMMAND (Owner Only) ---
Module({
    pattern: "antidelete ?(.*)",
    fromMe: true, 
    desc: "Manage Global Spy Antidelete",
    type: "security"
}, async (m, match) => {
    const cmd = match[1]?.toLowerCase().trim();

    if (cmd === 'pc on') {
        await setVar('ANTIDELETE_PC_GLOBAL', 'true');
        return m.reply("✅ *Private Spy Active!*\nDeleted DMs will be forwarded to your Sudo.");
    } 
    else if (cmd === 'pc off') {
        await setVar('ANTIDELETE_PC_GLOBAL', 'false');
        return m.reply("❌ Private Spy Disabled.");
    }
    else if (cmd === 'group on') {
        await setVar('ANTIDELETE_GROUP_GLOBAL', 'true');
        return m.reply("✅ *Global Group Spy Active!*\nDeleted messages in ALL groups will be forwarded to your Sudo.");
    }
    else if (cmd === 'group off') {
        await setVar('ANTIDELETE_GROUP_GLOBAL', 'false');
        return m.reply("❌ Global Group Spy Disabled.");
    }
    else {
        const pcStatus = await getVar('ANTIDELETE_PC_GLOBAL') === 'true' ? "ON" : "OFF";
        const groupStatus = await getVar('ANTIDELETE_GROUP_GLOBAL') === 'true' ? "ON" : "OFF";
        
        return m.reply(
            `🕵️ *Antidelete Spy System (Standalone)*\n\n` +
            `👤 *Private Chats:* ${pcStatus}\n` +
            `👥 *All Groups:* ${groupStatus}\n\n` +
            `*Usage:*\n` +
            `• .antidelete pc on/off\n` +
            `• .antidelete group on/off`
        );
    }
});

// --- 4. THE DETECTOR (Catches Deletes) ---
Module({
    on: 'protocolMessage', 
    fromMe: false
}, async (m) => {
    try {
        // Check if it is a Delete Event (Revoke)
        if (m.data.message.protocolMessage.type !== 0) return;

        const deletedKey = m.data.message.protocolMessage.key;
        
        // Retrieve message from OUR internal memory (not global.store)
        const originalMsg = messageHistory.get(deletedKey.id);
        
        if (!originalMsg) return; // Message not found (maybe too old)

        // Ignore Self-Deletes
        if (originalMsg.key.fromMe) return;

        // --- PREPARE FORWARDING ---
        const target = getGlobalOwner(m.client);
        const sender = originalMsg.key.participant || originalMsg.key.remoteJid;
        let headerText = "";
        let shouldSend = false;

        // --- CHECK SWITCHES ---
        
        // Scenario A: Private Chat
        if (!m.isGroup) {
            const isPcOn = await getVar('ANTIDELETE_PC_GLOBAL');
            if (isPcOn === 'true') {
                shouldSend = true;
                headerText = `🗑️ *Deleted Private Message*\n👤 *From:* @${sender.split('@')[0]}`;
            }
        } 
        
        // Scenario B: Group Chat (GLOBAL CHECK)
        else {
            const isGroupOn = await getVar('ANTIDELETE_GROUP_GLOBAL');
            if (isGroupOn === 'true') {
                shouldSend = true;
                let groupName = "Unknown Group";
                try {
                    const metadata = m.client.getGroupInfo ? await m.client.getGroupInfo(m.jid) : await m.client.groupMetadata(m.jid);
                    groupName = metadata.subject;
                } catch(e) {}

                headerText = `🗑️ *Deleted Group Message*\n` +
                             `📍 *Group:* ${groupName}\n` +
                             `👤 *From:* @${sender.split('@')[0]}`;
            }
        }

        // --- EXECUTE FORWARD TO SUDO ---
        if (shouldSend) {
            // 1. Forward the message
            await m.client.sendMessage(target, { 
                forward: originalMsg, 
                contextInfo: { isForwarded: false } 
            });

            // 2. Send the Info
            await m.client.sendMessage(target, { 
                text: headerText,
                mentions: [sender]
            });
        }

    } catch (e) {
        console.error("Antidelete Error:", e);
    }
});
