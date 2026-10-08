const { Module } = require('../core/handler');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// Rate limit cooldown maps to prevent WhatsApp ban triggers
const lastAddTimestamp = new Map();
const ADD_COOLDOWN_MS = 30 * 1000; // 30 seconds between add actions

const lastTagTimestamp = new Map();
const TAG_COOLDOWN_MS = 60 * 1000; // 60 seconds between mass mentions

// --- HELPER: Cached Group Info ---
async function getGroupInfo(m) {
    if (!m.isGroup) return null;
    const metadata = m.client.getGroupInfo 
        ? await m.client.getGroupInfo(m.jid) 
        : await m.client.groupMetadata(m.jid);

    const myId = jidNormalizedUser(m.client.user?.id || '');
    const participant = metadata.participants.find(p => p.id === m.sender);
    const bot = metadata.participants.find(p => p.id === myId);

    return {
        metadata,
        isAdmin: !!(participant?.admin || m.fromMe || m.isOwner),
        isBotAdmin: !!(bot?.admin),
        participants: metadata.participants
    };
}

Module({ pattern: "kick", fromMe: false, desc: "Remove a member", type: "group" }, async (m) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    if (!info?.isBotAdmin) return m.reply("❌ I need to be Admin first!");
    
    let users = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (m.reply_message) users.push(m.reply_message.sender);
    if (users.length === 0) return m.reply("❌ Reply to a user or mention them.");
    
    await m.client.groupParticipantsUpdate(m.jid, users, 'remove');
    m.reply(`✅ Removed ${users.length} member(s).`);
});

Module({ pattern: "add ?(.*)", fromMe: false, desc: "Add a member", type: "group" }, async (m, match) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    if (!info?.isBotAdmin) return m.reply("❌ I need to be Admin first!");

    // Rate-limit .add commands to avoid instant WhatsApp bans
    const lastAdd = lastAddTimestamp.get(m.jid) || 0;
    if (Date.now() - lastAdd < ADD_COOLDOWN_MS) {
        const remaining = Math.ceil((ADD_COOLDOWN_MS - (Date.now() - lastAdd)) / 1000);
        return m.reply(`⏳ Anti-ban protection: Please wait ${remaining}s before adding another user.`);
    }

    const input = match[1] || m.reply_message?.text;
    if (!input) return m.reply("❌ Provide a phone number (e.g., .add 2348012345678).");
    
    const user = input.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    lastAddTimestamp.set(m.jid, Date.now());

    await m.client.groupParticipantsUpdate(m.jid, [user], 'add');
    m.reply("✅ Add request sent.");
});

Module({ pattern: "promote", fromMe: false, desc: "Promote to Admin", type: "group" }, async (m) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    if (!info?.isBotAdmin) return m.reply("❌ I need to be Admin first!");

    let users = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (m.reply_message) users.push(m.reply_message.sender);
    if (!users.length) return m.reply("❌ Reply to a user or mention them.");
    
    await m.client.groupParticipantsUpdate(m.jid, users, 'promote');
    m.reply("✅ User promoted to Admin.");
});

Module({ pattern: "demote", fromMe: false, desc: "Demote Admin", type: "group" }, async (m) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    if (!info?.isBotAdmin) return m.reply("❌ I need to be Admin first!");

    let users = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (m.reply_message) users.push(m.reply_message.sender);
    if (!users.length) return m.reply("❌ Reply to a user or mention them.");
    
    await m.client.groupParticipantsUpdate(m.jid, users, 'demote');
    m.reply("✅ User demoted.");
});

Module({ pattern: "mute", fromMe: false, desc: "Close group", type: "group" }, async (m) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    if (!info?.isBotAdmin) return m.reply("❌ I need to be Admin first!");

    await m.client.groupSettingUpdate(m.jid, 'announcement');
    m.reply("🔒 Group Closed (Admins only can send messages).");
});

Module({ pattern: "unmute", fromMe: false, desc: "Open group", type: "group" }, async (m) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    if (!info?.isBotAdmin) return m.reply("❌ I need to be Admin first!");

    await m.client.groupSettingUpdate(m.jid, 'not_announcement');
    m.reply("🔓 Group Opened (All members can send messages).");
});

Module({ pattern: "tag ?([\\s\\S]*)", fromMe: false, desc: "Tag everyone", type: "group" }, async (m, match) => {
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");

    // Cooldown on mass mentions to prevent ban from spam reports
    const lastTag = lastTagTimestamp.get(m.jid) || 0;
    if (Date.now() - lastTag < TAG_COOLDOWN_MS) {
        const remaining = Math.ceil((TAG_COOLDOWN_MS - (Date.now() - lastTag)) / 1000);
        return m.reply(`⏳ Tag cooldown active. Please wait ${remaining}s.`);
    }

    lastTagTimestamp.set(m.jid, Date.now());

    const mentions = info.participants.map(p => p.id);
    const customText = match[1]?.trim(); 
    const quoted = m.reply_message;

    if (customText) return await m.client.sendMessage(m.jid, { text: customText, mentions });
    if (quoted && (quoted.image || quoted.video)) {
        const buffer = await quoted.download();
        const type = quoted.image ? 'image' : 'video';
        return await m.client.sendMessage(m.jid, { [type]: buffer, caption: quoted.caption || "", mentions });
    }
    if (quoted && quoted.text) return await m.client.sendMessage(m.jid, { text: quoted.text, mentions });
    return await m.client.sendMessage(m.jid, { text: "📣 *Attention Everyone!*", mentions });
});
