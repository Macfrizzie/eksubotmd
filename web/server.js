const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');
const aiEngine = require('../core/aiEngine');
const firebaseSync = require('../core/firebase');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
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
        res.json({ success });
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

function startServer(port = 3000) {
    const PORT = process.env.PORT || port;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Web Dashboard running on port ${PORT} (http://0.0.0.0:${PORT})`);
    });
    return server;
}

module.exports = { app, server, startServer };
