const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate a unique session ID bundle from session folder
 * @param {string} sessionFolder - Path to session folder
 * @returns {Promise<string>} - Base64 encoded session ID
 */
async function encodeSession(sessionFolder) {
    try {
        if (!fs.existsSync(sessionFolder)) {
            throw new Error(`Session directory ${sessionFolder} does not exist`);
        }

        const files = fs.readdirSync(sessionFolder);
        const sessionData = {};
        
        for (const file of files) {
            const filePath = path.join(sessionFolder, file);
            if (fs.statSync(filePath).isFile()) {
                const data = fs.readFileSync(filePath, 'utf8');
                sessionData[file] = data;
            }
        }
        
        // Convert to JSON and encode
        const jsonString = JSON.stringify(sessionData);
        const compressed = Buffer.from(jsonString).toString('base64');
        
        // Generate unique prefix
        const hash = crypto.createHash('md5').update(compressed).digest('hex').substring(0, 8);
        return `EKSU_${hash}_${compressed}`;
    } catch (error) {
        throw new Error(`Failed to encode session: ${error.message}`);
    }
}

/**
 * Decode session ID and restore to session folder
 * Supports both full EKSU bundle and standalone base64 creds.json
 * @param {string} sessionId - The session ID from .env
 * @param {string} sessionFolder - Destination path
 * @returns {Promise<void>}
 */
async function decodeSession(sessionId, sessionFolder) {
    try {
        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error('Empty or invalid session ID');
        }

        if (!fs.existsSync(sessionFolder)) {
            fs.mkdirSync(sessionFolder, { recursive: true });
        }

        // Case 1: EKSU Multi-file Bundle
        if (sessionId.startsWith('EKSU_')) {
            const parts = sessionId.split('_');
            if (parts.length >= 3) {
                const base64Data = parts.slice(2).join('_');
                const jsonString = Buffer.from(base64Data, 'base64').toString('utf8');
                const sessionData = JSON.parse(jsonString);

                for (const [filename, content] of Object.entries(sessionData)) {
                    const filePath = path.join(sessionFolder, filename);
                    fs.writeFileSync(filePath, content, 'utf8');
                }
                console.log(`✅ Restored ${Object.keys(sessionData).length} session auth files from EKSU bundle`);
                return;
            }
        }

        // Case 2: Standalone Base64 (or prefixed like 'EksuMD~...')
        let rawBase64 = sessionId.trim();
        if (rawBase64.includes('~')) {
            rawBase64 = rawBase64.split('~')[1];
        }

        const decodedBuffer = Buffer.from(rawBase64, 'base64');
        const decodedText = decodedBuffer.toString('utf8');

        // Check if it's a JSON payload
        try {
            const parsed = JSON.parse(decodedText);
            // If it's a multi-file object map
            if (parsed && typeof parsed === 'object' && !parsed.noiseKey && Object.keys(parsed).some(k => k.endsWith('.json'))) {
                for (const [filename, content] of Object.entries(parsed)) {
                    fs.writeFileSync(path.join(sessionFolder, filename), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
                }
                console.log(`✅ Restored session files from JSON bundle.`);
                return;
            }
        } catch (e) {}

        // Otherwise write directly as creds.json
        const credsPath = path.join(sessionFolder, 'creds.json');
        fs.writeFileSync(credsPath, decodedBuffer);
        console.log(`✅ Restored creds.json successfully.`);
    } catch (error) {
        throw new Error(`Failed to decode session: ${error.message}`);
    }
}

function clearSession(sessionFolder) {
    try {
        if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            console.log('✅ Session cleared');
        }
    } catch (error) {
        console.error('❌ Failed to clear session:', error);
    }
}

module.exports = {
    encodeSession,
    decodeSession,
    clearSession
};