const { jidNormalizedUser, downloadMediaMessage } = require('@whiskeysockets/baileys');

// Helper to download media safely
const downloadMedia = async (m) => {
    try { 
        return await downloadMediaMessage(m, 'buffer', {}, { logger: console }); 
    } catch (e) { 
        return null; 
    }
};

// Global Outbound Message Rate Pacer (Prevents rapid message bursts)
let lastSendPromise = Promise.resolve();
const MIN_SEND_GAP_MS = 800; // 0.8s minimum spacing between outbound messages

function pacedSend(sendFn) {
    const p = lastSendPromise.then(async () => {
        await new Promise(resolve => setTimeout(resolve, MIN_SEND_GAP_MS + Math.floor(Math.random() * 300)));
        return sendFn();
    });
    // Keep chain going even on errors
    lastSendPromise = p.catch(err => {
        console.error("Outbound message error:", err?.message || err);
    });
    return p;
}

async function serialize(sock, m) {
    if (!m) return m;
    const key = m.key;
    const device = sock.user ? jidNormalizedUser(sock.user.id) : '';
    
    m.client = sock; 
    m.id = key.id;
    m.isGroup = key.remoteJid ? key.remoteJid.endsWith('@g.us') : false;
    m.jid = key.remoteJid;

    // Prioritize real phone JID (@s.whatsapp.net) over LID
    let rawSender = '';
    if (key.fromMe) {
        rawSender = device;
    } else if (m.isGroup) {
        if (key.participant && key.participant.endsWith('@s.whatsapp.net')) {
            rawSender = key.participant;
        } else if (m.participant && m.participant.endsWith('@s.whatsapp.net')) {
            rawSender = m.participant;
        } else {
            rawSender = key.participant || m.participant || key.remoteJid || '';
        }
    } else {
        if (key.remoteJid && key.remoteJid.endsWith('@s.whatsapp.net')) {
            rawSender = key.remoteJid;
        } else if (key.participant && key.participant.endsWith('@s.whatsapp.net')) {
            rawSender = key.participant;
        } else {
            rawSender = key.remoteJid || key.participant || '';
        }
    }

    m.sender = jidNormalizedUser(rawSender);
    m.userPhone = m.sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    m.fromMe = !!key.fromMe;
    m.pushName = m.pushName || "User";
    m.data = m;

    // Determine Owner Status
    const sudoList = (process.env.SUDO || process.env.OWNER_NUMBERS || '')
        .split(',')
        .map(s => s.trim().replace(/[^0-9]/g, ''))
        .filter(Boolean)
        .map(s => s + '@s.whatsapp.net');

    m.isOwner = m.fromMe || sudoList.includes(m.sender);

    if (m.message) {
        m.type = Object.keys(m.message)[0];
        m.text = m.message.conversation || 
                 m.message.extendedTextMessage?.text || 
                 m.message.imageMessage?.caption || 
                 m.message.videoMessage?.caption || '';
    } else {
        m.type = '';
        m.text = '';
    }

    // Methods with paced sending to prevent ban triggers
    m.sendMessage = async (content, type = 'text', options = {}) => {
        return pacedSend(() => {
            const payload = Buffer.isBuffer(content) 
                ? { [type]: content, ...options } 
                : { text: content, ...options };
            return sock.sendMessage(m.jid, payload, { quoted: m, ...options });
        });
    };

    m.sendReply = async (text, options = {}) => {
        return pacedSend(() => {
            return sock.sendMessage(m.jid, { text: String(text), ...options }, { quoted: m, ...options });
        });
    };

    m.reply = m.sendReply;
    m.download = async () => downloadMedia(m);

    // Reply Object
    if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const q = m.message.extendedTextMessage.contextInfo;
        const msg = q.quotedMessage;
        const type = Object.keys(msg)[0];
        
        m.reply_message = {
            id: q.stanzaId, 
            jid: q.participant || m.jid, 
            sender: q.participant ? jidNormalizedUser(q.participant) : '', 
            fromMe: q.participant === device,
            type: type,
            text: msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || '',
            image: type === 'imageMessage', 
            video: type === 'videoMessage', 
            sticker: type === 'stickerMessage',
            download: async () => downloadMedia({ key: { remoteJid: m.jid, id: q.stanzaId, participant: q.participant }, message: msg })
        };
    } else {
        m.reply_message = false;
    }
    return m;
}

module.exports = serialize;
