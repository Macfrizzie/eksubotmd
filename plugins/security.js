const { Module } = require('../core/handler');
const { getVar, setVar } = require('../core/database');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// --- HELPER FUNCTIONS ---
async function getConfig(jid) {
    const data = await getVar(`ANTILINK_CONFIG_${jid}`);
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
}

async function saveConfig(jid, config) {
    await setVar(`ANTILINK_CONFIG_${jid}`, JSON.stringify(config));
}

const defaultConfig = { enabled: false, mode: 'delete', whitelist: [], blacklist: ['chat.whatsapp.com'] };

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

// 1. ANTILINK CONFIGURATION COMMAND
Module({
    pattern: "antilink ?(.*)",
    fromMe: false,
    desc: "Advanced Antilink",
    type: "security"
}, async (m, match) => {
    if (!m.isGroup) return m.reply("❌ Groups only.");
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");

    const input = match[1]?.trim();
    if (!input) return m.reply("Usage: .antilink on | off | mode <delete/kick> | allow <domain> | block <domain> | reset");

    let config = await getConfig(m.jid) || { ...defaultConfig };
    const args = input.split(" ");
    const cmd = args[0].toLowerCase();
    const value = args.slice(1).join(" ").trim();

    switch (cmd) {
        case 'on': 
            config.enabled = true; 
            await saveConfig(m.jid, config); 
            return m.reply("✅ Antilink Enabled for this group.");
        case 'off': 
            config.enabled = false; 
            await saveConfig(m.jid, config); 
            return m.reply("❌ Antilink Disabled.");
        case 'mode': 
            if (!['delete', 'kick'].includes(value.toLowerCase())) {
                return m.reply("❌ Invalid mode. Choose: .antilink mode delete OR .antilink mode kick");
            }
            config.mode = value.toLowerCase(); 
            await saveConfig(m.jid, config); 
            return m.reply(`✅ Antilink Mode set to: ${config.mode}`);
        case 'allow': 
            if (!value) return m.reply("❌ Provide a domain or keyword to whitelist.");
            config.whitelist.push(value.toLowerCase()); 
            await saveConfig(m.jid, config); 
            return m.reply(`✅ Whitelisted: ${value}`);
        case 'block': 
            if (!value) return m.reply("❌ Provide a domain or keyword to blacklist.");
            config.blacklist.push(value.toLowerCase()); 
            await saveConfig(m.jid, config); 
            return m.reply(`✅ Blacklisted: ${value}`);
        case 'reset': 
            await saveConfig(m.jid, defaultConfig); 
            return m.reply("🔄 Antilink configuration reset to defaults.");
        default: 
            return m.reply("❌ Unknown subcommand. Usage: .antilink on/off/mode/allow/block/reset");
    }
});

// 2. ACTIVE ANTILINK ENFORCER LISTENER
Module({
    on: 'text',
    fromMe: false
}, async (m, text) => {
    try {
        if (!m.isGroup || m.fromMe || m.isOwner) return;

        const config = await getConfig(m.jid);
        if (!config || !config.enabled) return;

        const linkRegex = /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+)/gi;
        const matches = text.match(linkRegex);
        if (!matches || matches.length === 0) return;

        // Check if any link violates blacklist / whitelist
        const isViolating = matches.some(link => {
            const lower = link.toLowerCase();
            if (config.whitelist && config.whitelist.some(w => lower.includes(w))) {
                return false; // Whitelisted
            }
            if (config.blacklist && config.blacklist.some(b => lower.includes(b))) {
                return true;
            }
            return lower.includes('chat.whatsapp.com');
        });

        if (!isViolating) return;

        const info = await getGroupInfo(m);
        // Do not punish group admins
        if (info?.isAdmin) return;

        if (info?.isBotAdmin) {
            // Delete violating message
            try {
                await m.client.sendMessage(m.jid, { delete: m.key });
            } catch (e) {}

            if (config.mode === 'kick') {
                await m.client.groupParticipantsUpdate(m.jid, [m.sender], 'remove');
                m.reply(`🚫 *Antilink*: @${m.sender.split('@')[0]} removed for unauthorized link sharing.`, {
                    mentions: [m.sender]
                });
            } else {
                m.reply(`⚠️ *Antilink*: Links are not allowed in this group.`);
            }
        }
    } catch (err) {
        console.error("Antilink enforcer error:", err.message);
    }
});

// 3. WARN SYSTEM
Module({
    pattern: "warn",
    fromMe: false,
    desc: "Warn user (3 strikes kicks)",
    type: "security"
}, async (m) => {
    if (!m.isGroup) return m.reply("❌ Groups only.");
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    
    const target = m.reply_message?.sender || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) return m.reply("❌ Reply to a user or mention them.");

    let warns = await getVar(`WARN_${m.jid}`) || "{}";
    try { warns = JSON.parse(warns); } catch { warns = {}; }
    
    warns[target] = (warns[target] || 0) + 1;
    await setVar(`WARN_${m.jid}`, JSON.stringify(warns));

    if (warns[target] >= 3) {
        m.reply(`🚫 3 Warnings accumulated. Removing @${target.split('@')[0]}...`, { mentions: [target] });
        if (info?.isBotAdmin) {
            await m.client.groupParticipantsUpdate(m.jid, [target], 'remove');
        } else {
            m.reply("⚠️ Cannot kick user: I need Admin privileges.");
        }
        delete warns[target];
        await setVar(`WARN_${m.jid}`, JSON.stringify(warns));
    } else {
        m.reply(`⚠️ Warning issued to @${target.split('@')[0]} (${warns[target]}/3).`, { mentions: [target] });
    }
});

// 4. RESET WARNS
Module({
    pattern: "resetwarn",
    fromMe: false,
    desc: "Reset warns for a user",
    type: "security"
}, async (m) => {
    if (!m.isGroup) return m.reply("❌ Groups only.");
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");
    
    const target = m.reply_message?.sender || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) return m.reply("❌ Reply to a user or mention them.");
    
    let warns = await getVar(`WARN_${m.jid}`) || "{}";
    try { warns = JSON.parse(warns); } catch { warns = {}; }
    
    delete warns[target];
    await setVar(`WARN_${m.jid}`, JSON.stringify(warns));
    m.reply(`✅ Warnings reset for @${target.split('@')[0]}.`, { mentions: [target] });
});
