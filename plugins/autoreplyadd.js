const { Module } = require('../core/handler');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');

// --- File Paths ---
const AUTO_REPLY_FILE = path.join(__dirname, '..', 'auto_replies.json');

// --- Configuration ---
const GITHUB_GIST_TOKEN = process.env.GITHUB_GIST_TOKEN || '';
const AUTO_REPLY_GIST_ID = process.env.AUTO_REPLY_GIST_ID || '';
const ENABLE_GIST_BACKUP = process.env.ENABLE_GIST_BACKUP === 'true';
const GIST_FILENAME = 'auto_replies.json';

// --- Gist Helper Functions ---

async function backupToGist(notifyCallback = null) {
    if (!ENABLE_GIST_BACKUP) {
        if (notifyCallback) await notifyCallback('Gist backup is disabled.');
        return;
    }
    if (!GITHUB_GIST_TOKEN) {
        if (notifyCallback) await notifyCallback('GITHUB_GIST_TOKEN is not set.');
        console.error('GIST_BACKUP: GITHUB_GIST_TOKEN is not set.');
        return;
    }

    try {
        if (!fsSync.existsSync(AUTO_REPLY_FILE)) {
            if (notifyCallback) await notifyCallback('Auto-reply file does not exist.');
            return;
        }

        const autoRepliesContent = await fs.readFile(AUTO_REPLY_FILE, 'utf8');
        const gistDescription = `EKSUBOT Auto-replies backup | Last Updated: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}`;

        const headers = {
            'Authorization': `token ${GITHUB_GIST_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
        };

        const data = {
            description: gistDescription,
            files: {
                [GIST_FILENAME]: {
                    content: autoRepliesContent
                }
            }
        };

        if (AUTO_REPLY_GIST_ID) {
            if (notifyCallback) await notifyCallback('Updating existing Gist...');
            const response = await axios.patch(`https://api.github.com/gists/${AUTO_REPLY_GIST_ID}`, data, {
                headers
            });
            if (notifyCallback) await notifyCallback(`✅ Gist backup updated successfully!\nURL: ${response.data.html_url}`);
        } else {
            if (notifyCallback) await notifyCallback('Creating new Gist...');
            data.public = false;
            const response = await axios.post('https://api.github.com/gists', data, {
                headers
            });
            if (notifyCallback) await notifyCallback(`✅ New Gist created! Please add the following to your environment variables and restart:\n\n\`\`\`AUTO_REPLY_GIST_ID=${response.data.id}\`\`\`\n\nURL: ${response.data.html_url}`);
        }
    } catch (error) {
        console.error('GIST_BACKUP_ERROR:', error.response ? error.response.data : error.message);
        if (notifyCallback) await notifyCallback(`❌ Gist backup failed. Check logs for details.`);
    }
}

async function restoreFromGist(notifyCallback = null, input = null) {
    let content = null;
    let sourceDescription = "Gist ID";

    try {
        if (input && input.includes('gist.githubusercontent.com')) {
            if (notifyCallback) await notifyCallback('🔄 Fetching raw data from URL...');
            const response = await axios.get(input);
            content = typeof response.data === 'object' ? JSON.stringify(response.data, null, 2) : response.data;
            sourceDescription = "Raw URL";
        } else {
            if (!GITHUB_GIST_TOKEN) {
                if (notifyCallback) await notifyCallback('❌ GITHUB_GIST_TOKEN is not set.');
                return;
            }

            let targetId = AUTO_REPLY_GIST_ID;
            if (input) {
                const match = input.match(/([a-f0-9]{32})/i);
                if (match) targetId = match[1];
                else if (!input.includes('http')) targetId = input;
            }

            if (!targetId) {
                if (notifyCallback) await notifyCallback('❌ No Gist ID provided and AUTO_REPLY_GIST_ID is not set.');
                return;
            }

            if (notifyCallback) await notifyCallback(`🔄 Fetching via GitHub API (${sourceDescription})...`);
            
            const headers = { 
                'Authorization': `token ${GITHUB_GIST_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            };
            
            const response = await axios.get(`https://api.github.com/gists/${targetId}`, { headers });
            const files = response.data.files;
            let targetFile = files[GIST_FILENAME];

            if (!targetFile) {
                const jsonFileKey = Object.keys(files).find(key => key.endsWith('.json'));
                if (jsonFileKey) targetFile = files[jsonFileKey];
            }
            content = targetFile?.content;
        }

        if (!content) {
             if (notifyCallback) await notifyCallback('❌ Could not find valid file content.');
             return;
        }

        try {
            const stringContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
            JSON.parse(stringContent); // Verify JSON validity
            await fs.writeFile(AUTO_REPLY_FILE, stringContent, 'utf8');
            if (notifyCallback) await notifyCallback('✅ Auto-replies successfully restored!');
        } catch (jsonError) {
            if (notifyCallback) await notifyCallback('❌ Content is not valid JSON. Aborting restore.');
        }
    } catch (error) {
        console.error('GIST_RESTORE_ERROR:', error);
        if (notifyCallback) await notifyCallback(`❌ Restore failed: ${error.message}`);
    }
}

// --- File Helper Functions ---
async function loadAutoReplies() {
    try {
        if (!fsSync.existsSync(AUTO_REPLY_FILE)) {
            await fs.writeFile(AUTO_REPLY_FILE, '{}', 'utf8');
            return {};
        }
        const data = await fs.readFile(AUTO_REPLY_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading auto-replies:', error);
        return {};
    }
}

async function saveAutoReplies(autoReplies) {
    try {
        await fs.writeFile(AUTO_REPLY_FILE, JSON.stringify(autoReplies, null, 2), 'utf8');
        if (ENABLE_GIST_BACKUP) backupToGist(() => {}).catch(console.error);
    } catch (error) {
        console.error('Error saving auto-replies:', error);
    }
}

// --- Utility Functions ---
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAddCommandArgs(fullArgs) {
    const parts = { triggers: [], response: '', matchType: 'contains' };
    const trimmedArgs = fullArgs.trim();

    if (trimmedArgs[0] !== '"') return null;
    const firstQuoteEndIndex = trimmedArgs.indexOf('"', 1);
    if (firstQuoteEndIndex === -1) return null;

    const triggersString = trimmedArgs.substring(1, firstQuoteEndIndex);
    const remainder = trimmedArgs.substring(firstQuoteEndIndex + 1).trim();
    const secondQuoteEndIndex = remainder.indexOf('"', 1);
    if (remainder[0] !== '"' || secondQuoteEndIndex === -1) return null;

    const responseString = remainder.substring(1, secondQuoteEndIndex);
    const matchTypeString = remainder.substring(secondQuoteEndIndex + 1).trim().toLowerCase();
    const validMatchTypes = ['exact', 'similar', 'contains', 'starts with', 'ends with'];

    parts.matchType = validMatchTypes.includes(matchTypeString) ? matchTypeString : 'contains';
    parts.triggers = triggersString.split('::').map(s => s.trim()).filter(s => s);
    parts.response = responseString.split('::').map(s => s.trim());

    if (parts.triggers.length === 0 || parts.response.length === 0 || !parts.response[0]) return null;
    return parts;
}

function parseDelCommandArgs(fullArgs) {
    const match = fullArgs.match(/^"(.*?)"$/);
    if (!match) return null;
    return match[1].trim();
}

function replacePlaceholders(text, message) {
    let result = text;
    const username = message.pushName || message.data?.pushName || message.sender.split('@')[0];
    result = result.replace(/\(username\)/g, username);
    return result;
}

// --- Auto-Reply Plugin Modules ---

Module({
    pattern: 'autoreplyadd ?(.*)',
    fromMe: true,
    desc: 'Adds an auto-reply.',
    type: 'owner'
}, async (message, match) => {
    try {
        const parsedArgs = parseAddCommandArgs(match[1]);
        if (!parsedArgs) return await message.sendReply('Invalid format. Usage: .autoreplyadd "trigger" "response" [matchType]');
        const { triggers, response, matchType } = parsedArgs;
        const autoReplies = await loadAutoReplies();
        triggers.forEach(trigger => {
            if (trigger) autoReplies[trigger.toLowerCase()] = { response, matchType };
        });
        await saveAutoReplies(autoReplies);
        await message.sendReply(`Auto-replies added for: ${triggers.map(t => `"${t}"`).join(', ')}.`);
    } catch (e) {
        console.error(e);
        await message.sendReply('Failed to add auto-reply.');
    }
});

Module({
    pattern: 'autoreplylist',
    fromMe: true,
    desc: 'Lists all auto-replies.',
    type: 'owner'
}, async (message, match) => {
    try {
        const autoReplies = await loadAutoReplies();
        const keys = Object.keys(autoReplies);
        if (keys.length === 0) return await message.sendReply('No auto-replies configured.');
        let reply = '*Configured Auto-replies:*\n\n';
        keys.forEach(key => {
            const entry = autoReplies[key];
            reply += `*Trigger:* "${key}"\n*Type:* "${entry.matchType}"\n*Responses:* "${Array.isArray(entry.response) ? entry.response.join(' | ') : entry.response}"\n\n`;
        });
        await message.sendReply(reply.trim());
    } catch (e) {
        console.error(e);
        await message.sendReply('Failed to list auto-replies.');
    }
});

Module({
    pattern: 'autoreplydel ?(.*)',
    fromMe: true,
    desc: 'Deletes an auto-reply.',
    type: 'owner'
}, async (message, match) => {
    try {
        const trigger = parseDelCommandArgs(match[1]);
        if (!trigger) return await message.sendReply('Invalid format. Usage: .autoreplydel "trigger"');
        const autoReplies = await loadAutoReplies();
        if (autoReplies[trigger.toLowerCase()]) {
            delete autoReplies[trigger.toLowerCase()];
            await saveAutoReplies(autoReplies);
            await message.sendReply(`Auto-reply for "${trigger}" deleted.`);
        } else {
            await message.sendReply(`No auto-reply found for "${trigger}".`);
        }
    } catch (e) {
        console.error(e);
        await message.sendReply('Failed to delete auto-reply.');
    }
});

Module({
    pattern: 'autoreplygistbackup',
    fromMe: true,
    desc: 'Backs up auto-replies to Gist.',
    type: 'owner'
}, async (message, match) => {
    await backupToGist((text) => message.sendReply(text));
});

Module({
    pattern: 'autoreplygistrestore ?(.*)',
    fromMe: true,
    desc: 'Restores auto-replies from Gist. Usage: .autoreplygistrestore [url_or_id]',
    type: 'owner'
}, async (message, match) => {
    const input = match[1]?.trim();
    await restoreFromGist((text) => message.sendReply(text), input);
});

// --- Main Message Listener ---
const autoReplyCooldown = new Map();
const AUTOREPLY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown per sender

Module({
    on: 'text',
    fromMe: false // Auto-replies do not trigger on owner's messages
}, async (message) => {
    try {
        // --- 1. Filter out Groups and Self ---
        if (message.isGroup || message.fromMe) return;

        // --- 2. Check Cooldown per Sender ---
        const lastSent = autoReplyCooldown.get(message.sender) || 0;
        if (Date.now() - lastSent < AUTOREPLY_COOLDOWN_MS) return;

        // --- 3. Get Message Text Correctly ---
        const rawText = message.text || (typeof message.message === 'string' ? message.message : '');

        // If no text found, or if it starts with the command prefix, ignore it.
        if (!rawText || rawText.startsWith(process.env.PREFIX || '.')) return;

        const messageText = rawText.trim().toLowerCase();
        
        const autoReplies = await loadAutoReplies();
        let matchedEntry = null;

        // --- 4. Matching Logic ---
        for (const triggerKey in autoReplies) {
            const entry = autoReplies[triggerKey];
            const trigger = triggerKey.toLowerCase();
            const matchType = entry.matchType || 'contains';
            let isMatch = false;

            switch (matchType) {
                case 'exact':
                    isMatch = messageText === trigger;
                    break;
                case 'starts with':
                    isMatch = messageText.startsWith(trigger);
                    break;
                case 'ends with':
                    isMatch = messageText.endsWith(trigger);
                    break;
                case 'similar':
                    isMatch = new RegExp(`\\b${escapeRegExp(trigger)}\\b`).test(messageText);
                    break;
                case 'contains':
                default:
                    isMatch = messageText.includes(trigger);
                    break;
            }

            if (isMatch) {
                matchedEntry = entry;
                break;
            }
        }

        // --- 5. Sending the Reply with Humanized Delays ---
        if (matchedEntry) {
            // Register cooldown immediately
            autoReplyCooldown.set(message.sender, Date.now());

            // Simulate human typing presence
            try {
                if (message.client?.presenceSubscribe) {
                    await message.client.presenceSubscribe(message.jid);
                }
                if (message.client?.sendPresenceUpdate) {
                    await message.client.sendPresenceUpdate('composing', message.jid);
                }
                const typingDelay = 1500 + Math.floor(Math.random() * 2000);
                await new Promise(resolve => setTimeout(resolve, typingDelay));
                if (message.client?.sendPresenceUpdate) {
                    await message.client.sendPresenceUpdate('paused', message.jid);
                }
            } catch (presenceErr) {}

            const responses = matchedEntry.response;
            const uniqueResponses = [...new Set(Array.isArray(responses) ? responses : [responses])];

            for (const reply of uniqueResponses) {
                await message.sendReply(replacePlaceholders(reply, message));
                // Jittered gaps (1.5 - 3 seconds) between multi-part messages
                const gap = 1500 + Math.floor(Math.random() * 1500);
                await new Promise(resolve => setTimeout(resolve, gap));
            }
        }
    } catch (error) {
        console.error('Fatal Error in message listener:', error);
    }
});
