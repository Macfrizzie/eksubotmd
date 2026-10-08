const axios = require('axios');
const fs = require('fs');
const path = require('path');

const KB_FILE = path.join(__dirname, '../knowledge_base.json');
const DB_FILE = path.join(__dirname, '../database.json');

class FirebaseSync {
    constructor() {
        this.projectId = process.env.FIREBASE_PROJECT_ID || '';
        this.apiKey = process.env.FIREBASE_API_KEY || '';
        this.lastSync = null;
        this.autoSyncInterval = null;
    }

    isConfigured() {
        return !!(process.env.FIREBASE_PROJECT_ID);
    }

    getBaseUrl() {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const keyParam = process.env.FIREBASE_API_KEY ? `?key=${process.env.FIREBASE_API_KEY}` : '';
        return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents${keyParam}`;
    }

    // Convert JavaScript object to Firestore REST fields format
    toFirestoreFields(obj) {
        const fields = {};
        for (const [key, val] of Object.entries(obj)) {
            if (typeof val === 'string') {
                fields[key] = { stringValue: val };
            } else if (typeof val === 'number') {
                fields[key] = { doubleValue: val };
            } else if (typeof val === 'boolean') {
                fields[key] = { booleanValue: val };
            } else if (Array.isArray(val)) {
                fields[key] = {
                    arrayValue: {
                        values: val.map(v => typeof v === 'object' ? { stringValue: JSON.stringify(v) } : { stringValue: String(v) })
                    }
                };
            } else if (typeof val === 'object' && val !== null) {
                fields[key] = { stringValue: JSON.stringify(val) };
            }
        }
        return { fields };
    }

    // Convert Firestore REST fields back to JavaScript object
    fromFirestoreFields(fields) {
        const result = {};
        if (!fields) return result;
        for (const [key, field] of Object.entries(fields)) {
            if (field.stringValue !== undefined) {
                try {
                    const parsed = JSON.parse(field.stringValue);
                    result[key] = (typeof parsed === 'object') ? parsed : field.stringValue;
                } catch {
                    result[key] = field.stringValue;
                }
            } else if (field.doubleValue !== undefined) {
                result[key] = field.doubleValue;
            } else if (field.integerValue !== undefined) {
                result[key] = parseInt(field.integerValue, 10);
            } else if (field.booleanValue !== undefined) {
                result[key] = field.booleanValue;
            } else if (field.arrayValue?.values) {
                result[key] = field.arrayValue.values.map(v => {
                    const str = v.stringValue;
                    try { return JSON.parse(str); } catch { return str; }
                });
            }
        }
        return result;
    }

    async pushToCloud() {
        if (!this.isConfigured()) {
            throw new Error('FIREBASE_PROJECT_ID is not configured in .env');
        }

        const projectId = process.env.FIREBASE_PROJECT_ID;
        const keyQuery = process.env.FIREBASE_API_KEY ? `?key=${process.env.FIREBASE_API_KEY}` : '';

        // 1. Sync Knowledge Base
        let kbData = {};
        if (fs.existsSync(KB_FILE)) {
            kbData = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
        }

        const kbPayload = {
            fields: {
                systemPrompt: { stringValue: kbData.systemPrompt || '' },
                enabled: { booleanValue: !!kbData.enabled },
                provider: { stringValue: kbData.provider || 'gemini' },
                model: { stringValue: kbData.model || 'gemini-1.5-flash' },
                temperature: { doubleValue: kbData.temperature || 0.7 },
                dmOnly: { booleanValue: kbData.dmOnly !== false },
                entriesJson: { stringValue: JSON.stringify(kbData.entries || []) },
                updatedAt: { stringValue: new Date().toISOString() }
            }
        };

        const kbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/bot_config/knowledge_base${keyQuery}`;
        await axios.patch(kbUrl, kbPayload, { timeout: 15000 });

        // 2. Sync Bot Database Variables
        if (fs.existsSync(DB_FILE)) {
            const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            const dbPayload = {
                fields: {
                    dataJson: { stringValue: JSON.stringify(dbData) },
                    updatedAt: { stringValue: new Date().toISOString() }
                }
            };
            const dbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/bot_config/variables${keyQuery}`;
            await axios.patch(dbUrl, dbPayload, { timeout: 15000 });
        }

        this.lastSync = new Date().toISOString();
        console.log('☁️ Firebase Sync: Successfully backed up data to Cloud Firestore');
        return { success: true, timestamp: this.lastSync };
    }

    async pullFromCloud() {
        if (!this.isConfigured()) {
            throw new Error('FIREBASE_PROJECT_ID is not configured in .env');
        }

        const projectId = process.env.FIREBASE_PROJECT_ID;
        const keyQuery = process.env.FIREBASE_API_KEY ? `?key=${process.env.FIREBASE_API_KEY}` : '';

        // Pull Knowledge Base
        const kbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/bot_config/knowledge_base${keyQuery}`;
        const kbRes = await axios.get(kbUrl, { timeout: 15000 });
        const fields = kbRes.data?.fields || {};

        const restoredKB = {
            systemPrompt: fields.systemPrompt?.stringValue || '',
            enabled: fields.enabled?.booleanValue ?? true,
            provider: fields.provider?.stringValue || 'gemini',
            model: fields.model?.stringValue || 'gemini-1.5-flash',
            temperature: fields.temperature?.doubleValue || 0.7,
            dmOnly: fields.dmOnly?.booleanValue ?? true,
            entries: fields.entriesJson?.stringValue ? JSON.parse(fields.entriesJson.stringValue) : []
        };

        fs.writeFileSync(KB_FILE, JSON.stringify(restoredKB, null, 2), 'utf8');

        // Reload in memory
        const aiEngine = require('./aiEngine');
        aiEngine.loadKB();

        this.lastSync = new Date().toISOString();
        console.log('☁️ Firebase Sync: Successfully pulled data from Cloud Firestore');
        return { success: true, restoredKB, timestamp: this.lastSync };
    }

    getStatus() {
        return {
            configured: this.isConfigured(),
            projectId: process.env.FIREBASE_PROJECT_ID || 'Not set',
            lastSync: this.lastSync
        };
    }
}

const firebaseSync = new FirebaseSync();
module.exports = firebaseSync;
