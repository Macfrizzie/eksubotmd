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

const defaultConfig = {
    enabled: false,
    mode: 'delete', // 'delete', 'warn', 'remove' (kick)
    whitelist: ['eksu.edu.ng', 'youtube.com'],
    blacklist: ['chat.whatsapp.com']
};

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
    desc: "Advanced Antilink with warning, delete, and remove modes",
    type: "security"
}, async (m, match) => {
    if (!m.isGroup) return m.reply("❌ Groups only.");
    const info = await getGroupInfo(m);
    if (!info?.isAdmin && !m.isOwner) return m.reply("❌ Admin only.");

    const input = match[1]?.trim();
    let config = await getConfig(m.jid) || { ...defaultConfig };

    if (!input || input === 'status') {
        const allowed = config.whitelist?.length > 0 ? config.whitelist.join(', ') : 'None';
        return m.reply(
            `🛡️ *Antilink Configuration Status*\n\n` +
            `• *Status:* ${config.enabled ? '🟢 ENABLED' : '🔴 DISABLED'}\n` +
            `• *Action Mode:* *${config.mode.toUpperCase()}*\n` +
            `• *Allowed Domains:* ${allowed}\n\n` +
            `*Commands:*\n` +
            `• .antilink on / off\n` +
            `• .antilink mode <delete | warn | remove>\n` +
            `• .antilink allow <domain>\n` +
            `• .antilink disallow <domain>\n` +
            `• .antilink reset`
        );
    }

    const args = input.split(" ");
    const cmd = args[0].toLowerCase();
    const value = args.slice(1).join(" ").trim();

    switch (cmd) {
        case 'on': 
            config.enabled = true; 
            await saveConfig(m.jid, config); 
            return m.reply(`✅ *Antilink Enabled*\nAction Mode: *${config.mode.toUpperCase()}*`);

        case 'off': 
            config.enabled = false; 
            await saveConfig(m.jid, config); 
            return m.reply("❌ Antilink Disabled.");

        case 'mode': 
            let targetMode = value.toLowerCase();
            if (targetMode === 'kick') targetMode = 'remove';
            if (!['delete', 'warn', 'remove'].includes(targetMode)) {
                return m.reply("❌ Invalid mode. Choose:\n• .antilink mode delete\n• .antilink mode warn\n• .antilink mode remove");
            }
            config.mode = targetMode; 
            await saveConfig(m.jid, config); 
            return m.reply(`✅ Antilink Action Mode set to: *${config.mode.toUpperCase()}*`);

        case 'allow': 
            if (!value) return m.reply("❌ Provide a domain to allow.\nExample: .antilink allow youtube.com");
            const cleanDomain = value.toLowerCase().replace(/https?:\/\//, '').replace(/\/.*$/, '');
            if (!config.whitelist.includes(cleanDomain)) {
                config.whitelist.push(cleanDomain);
                await saveConfig(m.jid, config);
            }
            return m.reply(`✅ Allowed Domain Added: *${cleanDomain}*\nLinks to this domain won't be deleted.`);

        case 'disallow': 
            if (!value) return m.reply("❌ Provide a domain to remove from allowed list.");
            config.whitelist = config.whitelist.filter(w => !w.includes(value.toLowerCase()));
            await saveConfig(m.jid, config);
            return m.reply(`✅ Removed *${value}* from allowed domains.`);

        case 'allowed':
        case 'whitelist':
            const list = config.whitelist?.length > 0 ? config.whitelist.map((d, i) => `${i+1}. ${d}`).join('\n') : 'No allowed domains configured.';
            return m.reply(`🌐 *Allowed Domains:*\n\n${list}`);

        case 'reset': 
            await saveConfig(m.jid, defaultConfig); 
            return m.reply("🔄 Antilink configuration reset to defaults.");

        default: 
            return m.reply("❌ Unknown option. Type *.antilink* to see settings.");
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

        // Check if any link violates whitelist
        const isViolating = matches.some(link => {
            const lower = link.toLowerCase();
            // If domain is whitelisted, permit it
            if (config.whitelist && config.whitelist.some(w => lower.includes(w))) {
                return false;
            }
            return true;
        });

        if (!isViolating) return;

        const info = await getGroupInfo(m);
        // Do not punish admins
        if (info?.isAdmin) return;

        if (info?.isBotAdmin) {
            // 1. Delete violating message
            try {
                await m.client.sendMessage(m.jid, { delete: m.key });
            } catch (e) {}

            const mode = config.mode || 'delete';

            // 2. Handle Action Mode
            if (mode === 'remove') {
                // Instant kick
                await m.client.groupParticipantsUpdate(m.jid, [m.sender], 'remove');
                m.reply(`🚫 *Antilink*: @${m.sender.split('@')[0]} removed for sending unauthorized link.`, {
                    mentions: [m.sender]
                });
            } else if (mode === 'warn') {
                // 3-strike warning
                let warns = await getVar(`WARN_${m.jid}`) || "{}";
                try { warns = JSON.parse(warns); } catch { warns = {}; }
                warns[m.sender] = (warns[m.sender] || 0) + 1;
                await setVar(`WARN_${m.jid}`, JSON.stringify(warns));

                if (warns[m.sender] >= 3) {
                    m.reply(`🚫 *Antilink*: 3 Warnings reached for @${m.sender.split('@')[0]}. Removing user...`, {
                        mentions: [m.sender]
                    });
                    await m.client.groupParticipantsUpdate(m.jid, [m.sender], 'remove');
                    delete warns[m.sender];
                    await setVar(`WARN_${m.jid}`, JSON.stringify(warns));
                } else {
                    m.reply(`⚠️ *Antilink Warning*: Links are not allowed! @${m.sender.split('@')[0]} (Strike ${warns[m.sender]}/3)`, {
                        mentions: [m.sender]
                    });
                }
            } else {
                // Delete only
                m.reply(`⚠️ *Antilink*: Link deleted. Links are prohibited in this group.`);
            }
        }
    } catch (err) {
        console.error("Antilink enforcer error:", err.message);
    }
});

// 3. WARN SYSTEM COMMANDS
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
