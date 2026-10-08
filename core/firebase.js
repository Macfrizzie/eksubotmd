const axios = require('axios');
const fs = require('fs');
const path = require('path');

const KB_FILE = path.join(__dirname, '../knowledge_base.json');
const CONV_FILE = path.join(__dirname, '../conversations.json');
const ANALYTICS_FILE = path.join(__dirname, '../analytics.json');
const HANDOFF_FILE = path.join(__dirname, '../handoffs.json');
const DB_FILE = path.join(__dirname, '../database.json');

class FirebaseSync {
    constructor() {
        this.projectId = process.env.FIREBASE_PROJECT_ID || '';
        this.apiKey = process.env.FIREBASE_API_KEY || '';
        this.lastSync = null;
    }

    isConfigured() {
        return !!(process.env.FIREBASE_PROJECT_ID);
    }

    async saveDoc(collection, docId, dataObj) {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const keyQuery = process.env.FIREBASE_API_KEY ? `?key=${process.env.FIREBASE_API_KEY}` : '';
        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}${keyQuery}`;

        const payload = {
            fields: {
                dataJson: { stringValue: JSON.stringify(dataObj) },
                updatedAt: { stringValue: new Date().toISOString() }
            }
        };

        // If it's knowledge_base, also expose high-level fields for easy readability in Firebase Console
        if (docId === 'knowledge_base' && typeof dataObj === 'object') {
            payload.fields.systemPrompt = { stringValue: dataObj.systemPrompt || '' };
            payload.fields.enabled = { booleanValue: !!dataObj.enabled };
            payload.fields.model = { stringValue: dataObj.model || 'gemini-3.8-flash' };
            payload.fields.entriesCount = { integerValue: (dataObj.entries || []).length };
        }

        await axios.patch(url, payload, { timeout: 15000 });
    }

    async getDoc(collection, docId) {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const keyQuery = process.env.FIREBASE_API_KEY ? `?key=${process.env.FIREBASE_API_KEY}` : '';
        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}${keyQuery}`;

        try {
            const res = await axios.get(url, { timeout: 15000 });
            const fields = res.data?.fields || {};

            if (fields.dataJson?.stringValue) {
                return JSON.parse(fields.dataJson.stringValue);
            }

            // Fallback for legacy format
            if (docId === 'knowledge_base') {
                return {
                    systemPrompt: fields.systemPrompt?.stringValue || '',
                    enabled: fields.enabled?.booleanValue ?? true,
                    provider: fields.provider?.stringValue || 'gemini',
                    model: fields.model?.stringValue || 'gemini-3.8-flash',
                    temperature: fields.temperature?.doubleValue || 0.7,
                    dmOnly: fields.dmOnly?.booleanValue ?? true,
                    entries: fields.entriesJson?.stringValue ? JSON.parse(fields.entriesJson.stringValue) : []
                };
            }
            return null;
        } catch (err) {
            if (err.response && err.response.status === 404) {
                return null;
            }
            throw err;
        }
    }

    async pushToCloud() {
        if (!this.isConfigured()) {
            throw new Error('FIREBASE_PROJECT_ID is not configured in .env or Web Dashboard');
        }

        const backedUp = [];

        // 1. Knowledge Base
        if (fs.existsSync(KB_FILE)) {
            const kbData = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
            await this.saveDoc('bot_config', 'knowledge_base', kbData);
            backedUp.push('knowledge_base');
        }

        // 2. Conversations
        if (fs.existsSync(CONV_FILE)) {
            const convData = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
            await this.saveDoc('bot_config', 'conversations', convData);
            backedUp.push('conversations');
        }

        // 3. Analytics
        if (fs.existsSync(ANALYTICS_FILE)) {
            const analyticsData = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
            await this.saveDoc('bot_config', 'analytics', analyticsData);
            backedUp.push('analytics');
        }

        // 4. Handoffs
        if (fs.existsSync(HANDOFF_FILE)) {
            const handoffData = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
            await this.saveDoc('bot_config', 'handoffs', handoffData);
            backedUp.push('handoffs');
        }

        // 5. Database Variables
        if (fs.existsSync(DB_FILE)) {
            const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            await this.saveDoc('bot_config', 'variables', dbData);
            backedUp.push('variables');
        }

        // 6. Metadata Record
        await this.saveDoc('bot_config', 'meta', {
            lastBackup: new Date().toISOString(),
            files: backedUp,
            version: '7.0.0'
        });

        this.lastSync = new Date().toISOString();
        console.log(`☁️ Firebase Sync: Successfully backed up ${backedUp.join(', ')} to Cloud Firestore`);
        return { success: true, timestamp: this.lastSync, files: backedUp };
    }

    async pullFromCloud() {
        if (!this.isConfigured()) {
            throw new Error('FIREBASE_PROJECT_ID is not configured in .env or Web Dashboard');
        }

        const restored = [];

        // 1. Restore Knowledge Base
        const kbData = await this.getDoc('bot_config', 'knowledge_base');
        if (kbData) {
            fs.writeFileSync(KB_FILE, JSON.stringify(kbData, null, 2), 'utf8');
            restored.push('knowledge_base');
        }

        // 2. Restore Conversations
        const convData = await this.getDoc('bot_config', 'conversations');
        if (convData) {
            fs.writeFileSync(CONV_FILE, JSON.stringify(convData, null, 2), 'utf8');
            restored.push('conversations');
        }

        // 3. Restore Analytics
        const analyticsData = await this.getDoc('bot_config', 'analytics');
        if (analyticsData) {
            fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData, null, 2), 'utf8');
            restored.push('analytics');
        }

        // 4. Restore Handoffs
        const handoffData = await this.getDoc('bot_config', 'handoffs');
        if (handoffData) {
            fs.writeFileSync(HANDOFF_FILE, JSON.stringify(handoffData, null, 2), 'utf8');
            restored.push('handoffs');
        }

        // 5. Restore Database Variables
        const dbData = await this.getDoc('bot_config', 'variables');
        if (dbData) {
            fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
            restored.push('variables');
        }

        // Reload live state in memory
        try {
            const aiEngine = require('./aiEngine');
            aiEngine.loadKB();
            aiEngine.loadConversations();
            aiEngine.loadHandoffs();
        } catch (e) {
            console.error('Error reloading AI engine in memory:', e);
        }

        try {
            const analytics = require('./analytics');
            analytics.load();
        } catch (e) {
            console.error('Error reloading analytics in memory:', e);
        }

        this.lastSync = new Date().toISOString();
        console.log(`☁️ Firebase Sync: Successfully pulled ${restored.join(', ')} from Cloud Firestore`);
        return { success: true, timestamp: this.lastSync, files: restored };
    }

    getStatus() {
        return {
            configured: this.isConfigured(),
            projectId: process.env.FIREBASE_PROJECT_ID || '',
            apiKey: process.env.FIREBASE_API_KEY ? '••••••••' : '',
            lastSync: this.lastSync
        };
    }
}

const firebaseSync = new FirebaseSync();
module.exports = firebaseSync;
