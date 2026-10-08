const { Module } = require('../core/handler');
const { getVar, setVar } = require('../core/database');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// Default template
const DEFAULT_WELCOME = "👋 Welcome @{user} to *{group}*!\n\n📋 Feel free to read the group description and introduce yourself.\nEnjoy your stay! ✨";

async function getGroupInfo(m) {
    if (!m.isGroup) return null;
    const metadata = m.client.getGroupInfo ? await m.client.getGroupInfo(m.jid) : await m.client.groupMetadata(m.jid);
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

// 1. WELCOME COMMAND
Module({
    pattern: "welcome ?(.*)",
    fromMe: false,
    desc: "Configure group welcome messages",
    type: "group"
}, async (m, match) => {
    if (!m.isGroup) return m.reply("❌ This command is only for groups.");
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");

    const input = match[1]?.trim();
    if (!input) {
        const enabled = await getVar(`WELCOME_ENABLED_${m.jid}`) === 'true';
        const msg = await getVar(`WELCOME_MSG_${m.jid}`) || DEFAULT_WELCOME;
        return m.reply(
            `👋 *Group Welcome Message Status*\n\n` +
            `• *Status:* ${enabled ? '🟢 ON' : '🔴 OFF'}\n` +
            `• *Current Template:*\n${msg}\n\n` +
            `*Commands:*\n` +
            `• .welcome on\n` +
            `• .welcome off\n` +
            `• .welcome set <message>\n\n` +
            `_Placeholders:_ {user}, {group}, {desc}`
        );
    }

    const args = input.split(' ');
    const subCmd = args[0].toLowerCase();
    const rest = args.slice(1).join(' ').trim();

    if (subCmd === 'on') {
        await setVar(`WELCOME_ENABLED_${m.jid}`, 'true');
        return m.reply("✅ Welcome message *ENABLED* for this group.");
    } else if (subCmd === 'off') {
        await setVar(`WELCOME_ENABLED_${m.jid}`, 'false');
        return m.reply("❌ Welcome message *DISABLED* for this group.");
    } else if (subCmd === 'set') {
        if (!rest) return m.reply("❌ Provide a message template.\nExample: .welcome set Welcome @{user} to *{group}*!");
        await setVar(`WELCOME_MSG_${m.jid}`, rest);
        await setVar(`WELCOME_ENABLED_${m.jid}`, 'true');
        return m.reply(`✅ Welcome template updated and enabled:\n\n${rest}`);
    } else if (subCmd === 'reset') {
        await setVar(`WELCOME_MSG_${m.jid}`, DEFAULT_WELCOME);
        return m.reply("🔄 Welcome template reset to default.");
    } else {
        return m.reply("❌ Unknown option. Use: .welcome on | off | set <text> | reset");
    }
});

// 2. PARTICIPANT JOIN LISTENER
Module({
    on: 'group-participants.update',
    fromMe: false
}, async (sock, update) => {
    try {
        if (!update || update.action !== 'add') return;

        const groupJid = update.id;
        const isEnabled = await getVar(`WELCOME_ENABLED_${groupJid}`) === 'true';
        if (!isEnabled) return;

        const metadata = sock.getGroupInfo ? await sock.getGroupInfo(groupJid) : await sock.groupMetadata(groupJid);
        const template = await getVar(`WELCOME_MSG_${groupJid}`) || DEFAULT_WELCOME;

        for (const userJid of update.participants) {
            const userNumber = userJid.split('@')[0];
            let text = template
                .replace(/{user}/g, userNumber)
                .replace(/{group}/g, metadata.subject || 'Our Group')
                .replace(/{desc}/g, metadata.desc || 'No description');

            await sock.sendMessage(groupJid, {
                text,
                mentions: [userJid]
            });
            await new Promise(r => setTimeout(r, 1000));
        }
    } catch (e) {
        console.error("Welcome listener error:", e.message);
    }
});
