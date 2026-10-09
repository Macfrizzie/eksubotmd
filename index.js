require('dotenv').config();
const baileys = require('@whiskeysockets/baileys');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    jidNormalizedUser
} = baileys;
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

// --- 🛡️ CACHES & OPTIMIZATIONS ---
const botStartTime = Math.floor(Date.now() / 1000);
const messageStore = new Map();
const MAX_RAM_MESSAGES = 500; 

// Group metadata cache (5 minutes TTL) to prevent API rate-limiting
const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
// Message retry counter cache for resolving decryption failures
const msgRetryCounterCache = new NodeCache();
// Command rate limiter: Map of sender -> array of timestamps
const commandLimiter = new Map();

setInterval(() => {
    if (messageStore.size > MAX_RAM_MESSAGES) {
        let count = 0;
        for (const [key] of messageStore) {
            messageStore.delete(key);
            count++;
            if (messageStore.size <= MAX_RAM_MESSAGES) break;
        }
    }

    // Clean old command limiter timestamps (older than 1 minute)
    const oneMinAgo = Date.now() - 60000;
    for (const [sender, timestamps] of commandLimiter) {
        const active = timestamps.filter(t => t > oneMinAgo);
        if (active.length === 0) commandLimiter.delete(sender);
        else commandLimiter.set(sender, active);
    }
}, 5 * 60 * 1000);

global.store = {
    messages: messageStore,
    saveMessage: (key, message) => {
        if (key && key.id) {
            messageStore.set(key.id, { key, message, timestamp: Date.now() });
        }
    },
    getMessage: (id) => messageStore.get(id),
    bind: (ev) => {
        ev.on('messages.upsert', ({ messages }) => {
            if (!messages) return;
            messages.forEach(m => {
                if (m.message && m.key && m.key.id) {
                    messageStore.set(m.key.id, { key: m.key, message: m.message, timestamp: Date.now() });
                }
            });
        });
    }
};

// --- LOAD CORE & WEB DASHBOARD ---
const { Module, commands, listeners } = require('./core/handler');
const serialize = require('./core/manager');
const logger = require('./core/logger');
const { startServer } = require('./web/server');

// Start Web Management Interface
startServer(process.env.SERVER_PORT || process.env.PORT || 3000);

global.Module = Module;

// --- CRASH & CRYPTO ERROR PROTECTION ---
let consecutiveCryptoErrors = 0;
const MAX_CRYPTO_ERRORS_BEFORE_RESET = 10;

process.on('uncaughtException', (err) => {
    const isCryptoError = err.message.includes('Bad MAC') || 
                          err.message.includes('decryption') || 
                          err.message.includes('Session closed');

    if (isCryptoError) {
        consecutiveCryptoErrors++;
        console.warn(`⚠️ Transient Decrypt/Signal Key error (${consecutiveCryptoErrors}/${MAX_CRYPTO_ERRORS_BEFORE_RESET}): ${err.message}`);
        
        // Only wipe session if there is persistent corruption that retry keys couldn't heal
        if (consecutiveCryptoErrors >= MAX_CRYPTO_ERRORS_BEFORE_RESET) {
            console.error("💥 Persistent Session Corruption detected. Resetting session...");
            try { fs.rmSync('./session', { recursive: true, force: true }); } catch (e) {}
            process.exit(1);
        }
        return;
    }
    console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason?.message || reason);
});

let retries = 0;
let isPairingRequested = false;
let activeSock = null;

const { registerBotController } = require('./core/botController');

async function requestPairing(customNumber) {
    if (!activeSock) return { success: false, error: 'Socket is initializing. Please wait a few seconds.' };
    if (activeSock.authState.creds.registered) {
        return { success: false, error: 'Bot is already registered and logged in.' };
    }
    const targetNumber = (customNumber || process.env.PAIR_NUMBER || '').replace(/[^0-9]/g, '');
    if (!targetNumber) {
        return { success: false, error: 'Please set a valid phone number (e.g. 2348012345678).' };
    }
    console.log(`\n⏳ Requesting pairing code for: ${targetNumber}...`);
    try {
        const code = await activeSock.requestPairingCode(targetNumber);
        const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
        logger.setStatus({ pairingCode: formatted });
        console.log(`\n📞 PAIRING CODE: ${formatted}\n`);
        return { success: true, code: formatted };
    } catch (e) {
        console.error('❌ Failed to request pairing code:', e.message);
        return { success: false, error: e.message };
    }
}

registerBotController({
    requestPairing,
    restart: async () => {
        if (activeSock) {
            try { activeSock.ev.removeAllListeners(); } catch (e) {}
        }
        retries = 0;
        isPairingRequested = false;
        console.log('🔄 Restarting bot connection...');
        setTimeout(startEksuBot, 1500);
        return { success: true };
    }
});

async function startEksuBot() {
    try {
        console.log('🚀 Initializing Eksu-MD...');
        
        const sessionDir = path.resolve(__dirname, 'session');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        // Restore session from SESSION_ID if session/creds.json is absent
        const credsPath = path.join(sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath) && process.env.SESSION_ID) {
            try {
                let b64 = process.env.SESSION_ID.trim();
                if (b64.startsWith('EKSU_MD_')) b64 = b64.slice('EKSU_MD_'.length);
                else if (b64.startsWith('EKSU-MD~')) b64 = b64.slice('EKSU-MD~'.length);
                else if (b64.startsWith('EKSU~')) b64 = b64.slice('EKSU~'.length);

                const decoded = Buffer.from(b64, 'base64').toString('utf8');
                const parsed = JSON.parse(decoded);
                if (parsed && typeof parsed === 'object') {
                    fs.writeFileSync(credsPath, JSON.stringify(parsed, null, 2), 'utf8');
                    console.log('✅ WhatsApp session successfully restored from SESSION_ID!');
                }
            } catch (err) {
                console.error('⚠️ Failed to restore session from SESSION_ID:', err.message);
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        // Load Plugins once
        if (commands.length === 0) {
            const pluginDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pluginDir)) {
                console.log("📂 Loading Plugins...");
                fs.readdirSync(pluginDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        try { 
                            require(path.join(pluginDir, file)); 
                        } catch (e) {
                            console.error(`❌ Failed to load plugin ${file}:`, e.message);
                        }
                    }
                });
                console.log(`🧩 Plugins Loaded: ${commands.length} commands, ${listeners.length} listeners`);
            }
        }

        const browserInfo = (baileys.Browsers && typeof baileys.Browsers.ubuntu === 'function')
            ? baileys.Browsers.ubuntu('Chrome')
            : ["Ubuntu", "Chrome", "20.0.04"];

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: { 
                creds: state.creds, 
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) 
            },
            browser: browserInfo,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false, // Prevents loading history to save memory/CPU
            markOnlineOnConnect: false, // 🛑 CRITICAL: Do NOT mark online immediately (bot tell)
            msgRetryCounterCache,
            cachedGroupMetadata: async (jid) => groupCache.get(jid),
            getMessage: async (key) => {
                const stored = global.store?.getMessage(key.id);
                return stored ? stored.message : undefined;
            }
        });

        activeSock = sock;

        // Attach cached group metadata helper to socket
        sock.getGroupInfo = async (jid) => {
            let metadata = groupCache.get(jid);
            if (!metadata) {
                metadata = await sock.groupMetadata(jid);
                groupCache.set(jid, metadata);
            }
            return metadata;
        };

        if (global.store) global.store.bind(sock.ev);

        // Pairing code handling
        const rawPairNumber = process.env.PAIR_NUMBER || '';
        const pairNumber = rawPairNumber.replace(/[^0-9]/g, '');

        if (!sock.authState.creds.registered) {
            console.log('\n⚠️ BOT IS NOT REGISTERED.');
            console.log('📌 Open the Web Dashboard to request your WhatsApp Pairing Code on-demand.\n');
        }

        // Connection events with backoff
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔌 Connection closed (status: ${statusCode})`);

                logger.setStatus({ connected: false, connecting: true });

                // Drop handlers on closed socket to avoid memory leaks
                sock.ev.removeAllListeners();

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("🔴 Logged out from WhatsApp. Resetting session...");
                    logger.setStatus({ connected: false, connecting: false });
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    process.exit(1);
                } else if (statusCode === DisconnectReason.connectionReplaced) {
                    console.log("⚠️ Connection replaced by another active session. Exiting...");
                    logger.setStatus({ connected: false, connecting: false });
                    process.exit(1);
                } else {
                    const delay = Math.min(60000, 2000 * Math.pow(2, retries++));
                    console.log(`⏳ Reconnecting in ${(delay / 1000).toFixed(1)}s (retry attempt ${retries})...`);
                    setTimeout(startEksuBot, delay);
                }
            } else if (connection === 'open') {
                retries = 0;
                consecutiveCryptoErrors = 0;
                logger.setStatus({ 
                    connected: true, 
                    connecting: false, 
                    user: sock.user, 
                    pairingCode: null 
                });
                console.log('✅ Connected to WhatsApp successfully!');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Group participants update (Welcome / Goodbye / Auto-mod)
        sock.ev.on('group-participants.update', async (update) => {
            listeners.forEach(async (plugin) => {
                if (plugin.on === 'group-participants.update') {
                    try { await plugin.function(sock, update); } catch (e) {}
                }
            });
        });

        // Incoming message dispatcher
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                if (!chatUpdate.messages || chatUpdate.messages.length === 0) return;
                // Only process notification events to prevent re-processing history
                if (chatUpdate.type !== 'notify') return;

                for (let rawMessage of chatUpdate.messages) {
                    if (!rawMessage.message) continue;

                    // 1. Status broadcast isolation
                    if (rawMessage.key.remoteJid === 'status@broadcast') {
                        listeners.forEach(async (plugin) => {
                            if (plugin.on === 'status' || plugin.on === 'message') {
                                try { await plugin.function(rawMessage, null); } catch (e) {}
                            }
                        });
                        continue;
                    }

                    // 2. Ignore historical / stale messages (> 60s or before bot boot)
                    let msgTimestamp = 0;
                    if (rawMessage.messageTimestamp) {
                        const ts = rawMessage.messageTimestamp;
                        if (typeof ts === 'object' && ts !== null) {
                            msgTimestamp = ts.low || Number(ts.toString?.()) || 0;
                        } else {
                            msgTimestamp = Number(ts) || 0;
                        }
                    }

                    const nowSeconds = Math.floor(Date.now() / 1000);
                    if (msgTimestamp > 0) {
                        // Allow up to 180 seconds variance to tolerate server clock jitter
                        if (Math.abs(nowSeconds - msgTimestamp) > 180 && (nowSeconds - msgTimestamp > 180)) continue;
                        if (msgTimestamp < (botStartTime - 10)) continue;
                    }

                    // 3. Serialize message
                    const m = await serialize(sock, rawMessage);
                    if (!m) continue;

                    // 4. Trigger general listeners (message, text, specific types)
                    listeners.forEach(async (plugin) => {
                        try {
                            // Enforce fromMe permissions on listeners
                            if (plugin.fromMe === false && m.fromMe) return;
                            if (plugin.fromMe === true && !m.isOwner) return;

                            if (plugin.on === 'message') {
                                await plugin.function(m, m.text);
                            } else if (plugin.on === 'text' && m.text) {
                                await plugin.function(m, m.text);
                            } else if (plugin.on === m.type) {
                                await plugin.function(m, m.text);
                            }
                        } catch (listenerErr) {
                            console.error('Listener execution error:', listenerErr.message);
                        }
                    });

                    // 5. Command routing
                    const prefix = process.env.PREFIX || '.';
                    const isCmd = m.text && m.text.trim().startsWith(prefix);

                    if (isCmd) {
                        const botMode = (process.env.MODE || 'public').toLowerCase();

                        // Enforce private mode
                        if (botMode === 'private' && !m.isOwner) {
                            continue;
                        }

                        // Rate limiter: Max 5 commands per minute for non-owners
                        if (!m.isOwner) {
                            const now = Date.now();
                            const userHistory = commandLimiter.get(m.sender) || [];
                            const recent = userHistory.filter(t => now - t < 60000);

                            if (recent.length >= 5) {
                                console.warn(`⏳ Rate-limit: Blocked burst command from ${m.sender}`);
                                continue;
                            }
                            recent.push(now);
                            commandLimiter.set(m.sender, recent);
                        }

                        const plugin = commands.find(c => c.pattern instanceof RegExp && c.pattern.test(m.text));
                        if (plugin) {
                            if (plugin.fromMe && !m.isOwner) continue;
                            const match = m.text.match(plugin.pattern) || [];
                            await plugin.function(m, match);
                        }
                    }
                }
            } catch (e) {
                console.error("Error processing incoming message upsert:", e.message);
            }
        });
    } catch (error) {
        console.error("Initialization error:", error.message);
        const delay = Math.min(60000, 2000 * Math.pow(2, retries++));
        setTimeout(startEksuBot, delay);
    }
}

startEksuBot();
