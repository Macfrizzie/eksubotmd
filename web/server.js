const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');
const aiEngine = require('../core/aiEngine');
const firebaseSync = require('../core/firebase');
const analytics = require('../core/analytics');
const keywordEngine = require('../core/keywordEngine');
const welcomeEngine = require('../core/welcomeEngine');
const { exec } = require('child_process');
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
        const hard = req.query.hard === '1' || req.body?.hard === true;
        if (hard) {
            res.json({ success: true, message: 'Full server reboot initiated. Process is restarting...' });
            setTimeout(() => { process.exit(0); }, 800);
            return;
        }
        const { getBotController } = require('../core/botController');
        await getBotController().restart();
        res.json({ success: true, message: 'Bot restart initiated' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/server/reboot', (req, res) => {
    try {
        res.json({ success: true, message: 'Full server reboot initiated. Container is reloading node process...' });
        setTimeout(() => { process.exit(0); }, 800);
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

// Test query directly from web browser (Fixes [object Object] by properly unwrapping reply string)
app.post('/api/knowledge/test', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query is required', reply: 'Query is required' });
        const result = await aiEngine.generateReply(query, 'web_test', 'Web User', true);

        let textReply = 'No response generated.';
        if (typeof result === 'string') {
            textReply = result;
        } else if (result && typeof result === 'object') {
            if (typeof result.reply === 'string') {
                textReply = result.reply;
            } else if (result.reply && typeof result.reply === 'object') {
                textReply = result.reply.reply || JSON.stringify(result.reply);
            } else if (result.handoff) {
                textReply = `[Human Handoff Needed: ${result.handoff.reason}]`;
            }
        }

        res.json({ reply: textReply });
    } catch (e) {
        res.status(500).json({ error: e.message, reply: `Error: ${e.message}` });
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

app.post('/api/handoff/resume-all', (req, res) => {
    const success = aiEngine.clearAllHandoffs();
    res.json({ success });
});

// 7.1 Unanswered Questions & Knowledge Gaps API
app.get('/api/knowledge/unanswered', (req, res) => {
    res.json(aiEngine.getUnansweredQuestions());
});

app.delete('/api/knowledge/unanswered/:id', (req, res) => {
    const success = aiEngine.deleteUnansweredQuestion(req.params.id);
    res.json({ success });
});

app.delete('/api/knowledge/unanswered', (req, res) => {
    const success = aiEngine.clearUnansweredQuestions();
    res.json({ success });
});

// --- 8. KEYWORD AUTO-REPLY RULES API ---
app.get('/api/keywords', (req, res) => {
    res.json(keywordEngine.getState());
});

app.post('/api/keywords/config', (req, res) => {
    try {
        const { enabled, standalone } = req.body;
        const config = keywordEngine.updateConfig({ enabled, standalone });
        res.json({ success: true, ...config });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/keywords', (req, res) => {
    try {
        // Also handle config updates directly via /api/keywords as fallback
        if (req.body.action === 'config' || (req.body.standalone !== undefined && !req.body.keyword && !req.body.keywords)) {
            const config = keywordEngine.updateConfig({ enabled: req.body.enabled, standalone: req.body.standalone });
            return res.json({ success: true, ...config });
        }

        const { keywords, keyword, matchType, responses, response, enabled } = req.body;
        const finalKeywords = (keywords !== undefined && keywords !== null && keywords !== '') ? keywords : keyword;
        const finalResponses = (responses !== undefined && responses !== null && responses !== '') ? responses : response;

        if (!finalKeywords || (Array.isArray(finalKeywords) && finalKeywords.filter(Boolean).length === 0)) {
            return res.status(400).json({ error: 'At least one keyword is required.' });
        }
        if (!finalResponses || (Array.isArray(finalResponses) && finalResponses.filter(Boolean).length === 0)) {
            return res.status(400).json({ error: 'At least one preset response message is required.' });
        }

        const rule = keywordEngine.addRule(finalKeywords, matchType, finalResponses, enabled);
        res.json({ success: true, rule });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/keywords/:id', (req, res) => {
    try {
        const rule = keywordEngine.updateRule(req.params.id, req.body);
        if (!rule) return res.status(404).json({ error: 'Rule not found' });
        res.json({ success: true, rule });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/keywords/:id', (req, res) => {
    try {
        const deleted = keywordEngine.deleteRule(req.params.id);
        res.json({ success: deleted });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/keywords/test', (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query is required.' });
        const match = keywordEngine.findMatch(query);
        const config = keywordEngine.getConfig();
        res.json({ matched: !!match, match, config });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Dedicated 1-click Firebase sync for keywords
app.post('/api/keywords/firebase/push', async (req, res) => {
    try {
        const result = await firebaseSync.pushKeywords();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/keywords/firebase/pull', async (req, res) => {
    try {
        const result = await firebaseSync.pullKeywords();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 8.5 FIRST-TIME USER WELCOME & CONTACT SAVER FLOW API ---
app.get('/api/welcome/config', (req, res) => {
    res.json(welcomeEngine.getConfig());
});

app.post('/api/welcome/config', (req, res) => {
    try {
        const success = welcomeEngine.saveConfig(req.body);
        res.json({ success, config: welcomeEngine.getConfig() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/welcome/users', (req, res) => {
    res.json(welcomeEngine.getUsersList());
});

app.delete('/api/welcome/users/:id', (req, res) => {
    try {
        const success = welcomeEngine.resetUser(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/welcome/users', (req, res) => {
    try {
        const success = welcomeEngine.clearAllUsers();
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/welcome/test', (req, res) => {
    try {
        const { welcomeMessage, savedConfirmationMessage, name, phone } = req.body;
        const testName = name || 'John';
        const testPhone = phone || '2348012345678';
        const welcomePreview = welcomeEngine.formatText(welcomeMessage, testName, testPhone);
        const confirmPreview = welcomeEngine.formatText(savedConfirmationMessage, testName, testPhone);
        res.json({ welcomePreview, confirmPreview });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 9. GIT SYNC FOR PANEL HOSTING API ---
function runGit(cmd, cwd) {
    return new Promise((resolve) => {
        exec(cmd, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
            resolve({
                err,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim()
            });
        });
    });
}

async function ensureGitRepo(cwd, cleanUrl = null) {
    const gitDir = path.join(cwd, '.git');
    // Ensure safe directory for Docker / Pterodactyl environments
    await runGit('git config --global --add safe.directory "*"', cwd);

    if (!fs.existsSync(gitDir)) {
        console.log('📦 Initializing Git repository on panel...');
        await runGit('git init', cwd);
        await runGit('git config user.email "bot@eksu.local"', cwd);
        await runGit('git config user.name "EksuBot"', cwd);
        await runGit('git branch -M main', cwd);
    }

    if (cleanUrl) {
        const checkRemote = await runGit('git remote get-url origin', cwd);
        if (!checkRemote.err && checkRemote.stdout) {
            await runGit(`git remote set-url origin "${cleanUrl}"`, cwd);
        } else {
            const addRes = await runGit(`git remote add origin "${cleanUrl}"`, cwd);
            if (addRes.err) {
                await runGit(`git remote set-url origin "${cleanUrl}"`, cwd);
            }
        }
    }
}

app.get('/api/git/status', async (req, res) => {
    const cwd = path.join(__dirname, '..');
    const gitDir = path.join(cwd, '.git');

    if (!fs.existsSync(gitDir)) {
        return res.json({ 
            isGit: false, 
            error: 'Git repository not initialized on panel. Enter your GitHub repo URL below and save to link.',
            branch: 'None',
            commitHash: 'N/A',
            remoteUrl: ''
        });
    }

    await runGit('git config --global --add safe.directory "*"', cwd);

    const remoteRes = await runGit('git remote get-url origin', cwd);
    const remoteUrl = remoteRes.stdout || '';

    const branchRes = await runGit('git branch --show-current', cwd);
    const branch = branchRes.stdout || 'main';

    const commitRes = await runGit('git rev-parse --short HEAD', cwd);
    if (commitRes.err) {
        return res.json({
            isGit: true,
            branch: branch || 'main',
            commitHash: 'Uncommitted',
            commitMessage: 'Repository initialized (no commits yet)',
            remoteUrl
        });
    }

    const logRes = await runGit('git log -1 --pretty=%s (%cr)', cwd);
    res.json({
        isGit: true,
        branch: branch || 'main',
        commitHash: commitRes.stdout || '',
        commitMessage: logRes.stdout || '',
        remoteUrl
    });
});

app.post('/api/git/remote', async (req, res) => {
    try {
        const cwd = path.join(__dirname, '..');
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Remote URL is required' });

        const cleanUrl = url.trim();
        await ensureGitRepo(cwd, cleanUrl);

        res.json({ 
            success: true, 
            message: 'Git initialized and remote repository URL saved successfully!' 
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/git/pull', async (req, res) => {
    try {
        const cwd = path.join(__dirname, '..');
        const gitDir = path.join(cwd, '.git');

        if (!fs.existsSync(gitDir)) {
            return res.status(400).json({
                success: false,
                error: 'Git is not initialized yet. Please enter your GitHub repository URL above and save it first.'
            });
        }

        await runGit('git config --global --add safe.directory "*"', cwd);

        // Determine branch name (default to main)
        let branchRes = await runGit('git branch --show-current', cwd);
        let branch = branchRes.stdout || 'main';

        // Check if remote exists
        const remoteRes = await runGit('git remote get-url origin', cwd);
        if (remoteRes.err || !remoteRes.stdout) {
            return res.status(400).json({
                success: false,
                error: 'No Git remote URL configured. Please set your GitHub URL above and save it first.'
            });
        }

        // Fetch latest commits from remote
        let fetchRes = await runGit(`git fetch origin ${branch}`, cwd);
        if (fetchRes.err) {
            // Check if remote uses master instead of main
            const fetchMaster = await runGit('git fetch origin master', cwd);
            if (!fetchMaster.err) {
                branch = 'master';
                fetchRes = fetchMaster;
            } else {
                return res.status(500).json({
                    success: false,
                    error: `Git fetch failed: ${fetchRes.stderr || fetchRes.err.message}\n\nTip: If your GitHub repository is private, either make it Public or format the URL as: https://YOUR_TOKEN@github.com/username/repo.git`
                });
            }
        }

        // Try pull with merge
        let pullRes = await runGit(`git pull origin ${branch} --allow-unrelated-histories --no-rebase -X theirs`, cwd);
        if (pullRes.err) {
            // Auto-commit or stage uncommitted local files if preventing pull
            await runGit('git add -A', cwd);
            await runGit('git commit -m "Auto-commit local panel changes before sync"', cwd);
            pullRes = await runGit(`git pull origin ${branch} --allow-unrelated-histories --no-rebase -X theirs`, cwd);
        }

        if (pullRes.err) {
            return res.status(500).json({
                success: false,
                error: (pullRes.stderr || pullRes.err.message).trim(),
                output: pullRes.stdout
            });
        }

        res.json({
            success: true,
            output: (pullRes.stdout || 'Already up to date.').trim()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- 10. REUSABLE SESSION ID MANAGEMENT API ---
app.get('/api/session/export', (req, res) => {
    try {
        const credsPath = path.join(__dirname, '../session/creds.json');
        if (!fs.existsSync(credsPath)) {
            return res.json({ 
                success: true, 
                hasSession: false, 
                sessionId: null,
                message: 'No active session credentials found. Please pair with WhatsApp first.' 
            });
        }

        const credsContent = fs.readFileSync(credsPath, 'utf8');
        const parsed = JSON.parse(credsContent);
        const registered = !!parsed.registered;
        const userPhone = parsed.me?.id ? parsed.me.id.split('@')[0].split(':')[0] : null;

        const base64 = Buffer.from(credsContent).toString('base64');
        const sessionId = `EKSU_MD_${base64}`;

        res.json({
            success: true,
            hasSession: true,
            registered,
            userPhone,
            sessionId
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/session/import', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });

        let b64 = sessionId.trim();
        if (b64.startsWith('EKSU_MD_')) b64 = b64.slice('EKSU_MD_'.length);
        else if (b64.startsWith('EKSU-MD~')) b64 = b64.slice('EKSU-MD~'.length);
        else if (b64.startsWith('EKSU~')) b64 = b64.slice('EKSU~'.length);

        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);

        if (!parsed || typeof parsed !== 'object') {
            return res.status(400).json({ error: 'Invalid Session ID payload.' });
        }

        const sessionDir = path.join(__dirname, '../session');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(parsed, null, 2), 'utf8');

        // Also save to .env for persistence
        const currentEnv = parseEnvFile();
        currentEnv.SESSION_ID = sessionId.trim();
        writeEnvFile(currentEnv);
        process.env.SESSION_ID = sessionId.trim();

        console.log('🔐 WhatsApp Session imported successfully from Web Dashboard!');

        // Trigger bot connection restart with the restored session
        const { getBotController } = require('../core/botController');
        getBotController().restart().catch(() => {});

        res.json({ 
            success: true, 
            message: 'Session ID applied! Bot connection is restarting with the restored session.' 
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to import session ID: ' + e.message });
    }
});

// 11. One-Click Cloud Backup & Restore (.zip)
app.get('/api/backup/download', (req, res) => {
    try {
        const zip = new AdmZip();
        const rootDir = path.join(__dirname, '..');

        const filesToBackup = [
            'knowledge_base.json',
            'keyword_rules.json',
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
        keywordEngine.loadRules();
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
