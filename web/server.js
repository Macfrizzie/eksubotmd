const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');
const aiEngine = require('../core/aiEngine');
const firebaseSync = require('../core/firebase');
const analytics = require('../core/analytics');
const AdmZip = require('adm-zip');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// --- WEBSOCKET REAL-TIME BROADCASTS ---
const connectedClients = new Set();

wss.on('connection', (ws) => {
    connectedClients.add(ws);

    // Send initial status and history
    ws.send(JSON.stringify({ type: 'init', status: logger.getStatus(), logs: logger.getLogs() }));

    ws.on('close', () => {
        connectedClients.delete(ws);
    });
});

function broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of connectedClients) {
        if (client.readyState === 1) {
            client.send(payload);
        }
    }
}

logger.on('log', (entry) => {
    broadcast({ type: 'log', data: entry });
});

logger.on('status', (status) => {
    broadcast({ type: 'status', data: status });
});

logger.on('clear', () => {
    broadcast({ type: 'clear' });
});

// --- REST API ENDPOINTS ---

// 1. Bot Status
app.get('/api/status', (req, res) => {
    res.json(logger.getStatus());
});

// 2. Logs
app.get('/api/logs', (req, res) => {
    res.json(logger.getLogs());
});

app.delete('/api/logs', (req, res) => {
    logger.clearLogs();
    res.json({ success: true });
});

// 3. Environment Variables
const ENV_PATH = path.join(__dirname, '../.env');

function parseEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const result = {};
    content.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
                const key = trimmed.substring(0, eqIdx).trim();
                let val = trimmed.substring(eqIdx + 1).trim();
                // Strip quotes if present
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                result[key] = val;
            }
        }
    });
    return result;
}

function writeEnvFile(envObj) {
    let content = '# Auto-generated and updated via Eksu-MD Web Dashboard\n';
    for (const [k, v] of Object.entries(envObj)) {
        if (v !== undefined && v !== null) {
            content += `${k}=${v}\n`;
        }
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
}

app.get('/api/env', (req, res) => {
    const current = parseEnvFile();
    res.json(current);
});

app.post('/api/env', (req, res) => {
    try {
        const newSettings = req.body;
        const current = parseEnvFile();
        const updated = { ...current, ...newSettings };
        
        writeEnvFile(updated);

        // Update process.env in-memory
        for (const [k, v] of Object.entries(newSettings)) {
            process.env[k] = v;
        }

        console.log('⚙️ Environment variables updated via Web Dashboard');

        // If PAIR_NUMBER was updated, automatically request pairing code
        if (newSettings.PAIR_NUMBER) {
            const { getBotController } = require('../core/botController');
            getBotController().requestPairing(newSettings.PAIR_NUMBER).catch(() => {});
        }

        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bot Control Endpoints
app.post('/api/bot/pair', async (req, res) => {
    try {
        const { getBotController } = require('../core/botController');
        const result = await getBotController().requestPairing(req.body.number);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/bot/restart', async (req, res) => {
    try {
        const { getBotController } = require('../core/botController');
        await getBotController().restart();
        res.json({ success: true, message: 'Bot restart initiated' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. AI Knowledge Base Endpoints
app.get('/api/knowledge', (req, res) => {
    res.json(aiEngine.getKB());
});

app.post('/api/knowledge', (req, res) => {
    try {
        const success = aiEngine.saveKB(req.body);
        const enabled = aiEngine.getKB().enabled;
        logger.setStatus({ aiEnabled: enabled });
        res.json({ success, enabled });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/toggle', (req, res) => {
    try {
        const kb = aiEngine.getKB();
        const newState = req.body && req.body.enabled !== undefined ? !!req.body.enabled : !kb.enabled;
        aiEngine.saveKB({ enabled: newState });
        logger.setStatus({ aiEnabled: newState });
        res.json({ success: true, enabled: newState });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/knowledge/entry', (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
    const entry = aiEngine.addEntry(title, content);
    res.json({ success: true, entry });
});

app.put('/api/knowledge/entry/:id', (req, res) => {
    const { title, content } = req.body;
    const entry = aiEngine.updateEntry(req.params.id, title, content);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true, entry });
});

app.delete('/api/knowledge/entry/:id', (req, res) => {
    const deleted = aiEngine.deleteEntry(req.params.id);
    res.json({ success: deleted });
});

// Test query directly from web browser
app.post('/api/knowledge/test', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query is required' });
        const reply = await aiEngine.generateReply(query, 'web_test', 'Web User', true);
        res.json({ reply: reply || 'No response generated.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Firebase Sync Endpoints
app.get('/api/firebase/status', (req, res) => {
    res.json(firebaseSync.getStatus());
});

app.post('/api/firebase/push', async (req, res) => {
    try {
        const result = await firebaseSync.pushToCloud();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/firebase/pull', async (req, res) => {
    try {
        const result = await firebaseSync.pullFromCloud();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. Analytics API
app.get('/api/analytics', (req, res) => {
    res.json(analytics.getStats());
});

// 7. Human Handoff Queue API
app.get('/api/handoff', (req, res) => {
    res.json(aiEngine.getHandoffList());
});

app.post('/api/handoff/resume/:id', (req, res) => {
    const success = aiEngine.resumeAIForUser(req.params.id);
    res.json({ success });
});

// 8. One-Click Cloud Backup & Restore (.zip)
app.get('/api/backup/download', (req, res) => {
    try {
        const zip = new AdmZip();
        const rootDir = path.join(__dirname, '..');

        const filesToBackup = [
            'knowledge_base.json',
            'conversations.json',
            'analytics.json',
            'database.json',
            'handoffs.json',
            '.env'
        ];

        filesToBackup.forEach(file => {
            const fullPath = path.join(rootDir, file);
            if (fs.existsSync(fullPath)) {
                zip.addLocalFile(fullPath);
            }
        });

        const zipBuffer = zip.toBuffer();
        const filename = `eksubot-backup-${new Date().toISOString().substring(0, 10)}.zip`;

        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': zipBuffer.length
        });
        res.send(zipBuffer);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/restore', (req, res) => {
    try {
        const { base64Zip } = req.body;
        if (!base64Zip) return res.status(400).json({ error: 'Missing backup data' });

        const buffer = Buffer.from(base64Zip, 'base64');
        const zip = new AdmZip(buffer);
        const rootDir = path.join(__dirname, '..');

        zip.extractAllTo(rootDir, true);

        // Reload components in memory
        aiEngine.loadKB();
        aiEngine.loadConversations();
        aiEngine.loadHandoffs();
        analytics.load();

        console.log('📦 Complete Backup successfully restored to bot.');
        res.json({ success: true, message: 'Backup restored successfully' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function startServer(port = null) {
    const PORT = process.env.SERVER_PORT || process.env.PORT || port || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Web Dashboard running on port ${PORT} (http://0.0.0.0:${PORT})`);
        if (process.env.SERVER_PORT) {
            console.log(`📌 Pterodactyl panel detected: Allocated port is ${process.env.SERVER_PORT}`);
        }
    });
    return server;
}

module.exports = { app, server, startServer };
