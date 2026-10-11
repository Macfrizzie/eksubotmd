const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../welcome_config.json');
const USERS_FILE = path.join(__dirname, '../data/welcomed_users.json');

const DEFAULT_CONFIG = {
    enabled: false,
    dmOnly: true,
    welcomeMessage: `Hi {name}! 👋 Welcome to EKSU Assistant.\n\nKindly take a moment to save this contact as *EKSU Bot* so you don't miss important admission updates, announcements, and portal clearance guides.\n\nOnce you have saved it, reply with *SAVED* to continue! 😊`,
    saveKeywords: ["saved", "done", "i have saved", "saved it", "already saved"],
    savedConfirmationMessage: `Awesome, thank you for saving our contact, {name}! 🎉\n\nYour contact has been recorded. How can I assist you today? You can ask me anything about EKSU admissions, JAMB CAPS, acceptance fees, or portal screening!`,
    requireSavedBeforeChat: false,
    includeInAIKnowledge: true
};

class WelcomeEngine {
    constructor() {
        this.config = { ...DEFAULT_CONFIG };
        this.users = {};
        this.loadConfig();
        this.loadUsers();
    }

    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                this.config = { ...DEFAULT_CONFIG, ...data };
            } else {
                this.saveConfig(DEFAULT_CONFIG);
            }
        } catch (err) {
            console.error('Error loading welcome_config.json:', err.message);
            this.config = { ...DEFAULT_CONFIG };
        }
    }

    saveConfig(newConfig) {
        try {
            this.config = { ...this.config, ...newConfig };
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('Error saving welcome_config.json:', err.message);
            return false;
        }
    }

    loadUsers() {
        try {
            const dir = path.dirname(USERS_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            if (fs.existsSync(USERS_FILE)) {
                this.users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            } else {
                this.users = {};
                this.saveUsers();
            }
        } catch (err) {
            console.error('Error loading welcomed_users.json:', err.message);
            this.users = {};
        }
    }

    saveUsers() {
        try {
            const dir = path.dirname(USERS_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('Error saving welcomed_users.json:', err.message);
            return false;
        }
    }

    _normalizeId(senderId) {
        if (!senderId) return '';
        return String(senderId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    }

    getConfig() {
        return { ...this.config };
    }

    // Mark a user as already known/interacted with without sending them a welcome prompt
    markKnownUser(senderId, senderName = 'User') {
        const cleanId = this._normalizeId(senderId);
        if (!cleanId) return;

        if (!this.users[cleanId]) {
            this.users[cleanId] = {
                id: cleanId,
                name: (senderName && senderName !== 'User' && senderName !== 'Friend' && senderName !== 'undefined') ? senderName.trim() : 'User',
                status: 'known',
                welcomedAt: new Date().toISOString(),
                savedAt: new Date().toISOString()
            };
            this.saveUsers();
        }
    }

    // Check if this is a first-time user
    isFirstTimeUser(senderId) {
        if (!this.config.enabled) return false;
        const cleanId = this._normalizeId(senderId);
        if (!cleanId) return false;

        // 1. If already recorded in welcomed_users.json
        if (this.users[cleanId]) return false;

        // 2. Check if user already exists in conversations.json (has chatted before)
        try {
            const convFile = path.join(__dirname, '../conversations.json');
            if (fs.existsSync(convFile)) {
                const convData = JSON.parse(fs.readFileSync(convFile, 'utf8') || '{}');
                for (const key of Object.keys(convData)) {
                    const normKey = this._normalizeId(key);
                    if (normKey === cleanId && (convData[key]?.history?.length > 0 || convData[key]?.lastInteraction)) {
                        // User has interacted before - mark known and return false
                        this.markKnownUser(senderId);
                        return false;
                    }
                }
            }
        } catch (e) {}

        return true;
    }

    // Check if user has received the welcome message but not yet confirmed saving
    isAwaitingSave(senderId) {
        if (!this.config.enabled) return false;
        const cleanId = this._normalizeId(senderId);
        if (!cleanId || !this.users[cleanId]) return false;
        return this.users[cleanId].status === 'awaiting_saved';
    }

    // Record that the welcome message was sent
    recordFirstWelcome(senderId, senderName) {
        const cleanId = this._normalizeId(senderId);
        if (!cleanId) return;

        this.users[cleanId] = {
            id: cleanId,
            name: senderName || 'User',
            status: 'awaiting_saved',
            welcomedAt: new Date().toISOString(),
            savedAt: null
        };
        this.saveUsers();
    }

    // Check if message text matches the confirmation keywords (case-insensitive)
    isSaveTrigger(messageText) {
        if (!messageText || typeof messageText !== 'string') return false;
        const clean = messageText.trim().toLowerCase().replace(/[!.?,]/g, '');
        const triggers = Array.isArray(this.config.saveKeywords) ? this.config.saveKeywords : DEFAULT_CONFIG.saveKeywords;

        return triggers.some(kw => {
            const target = kw.trim().toLowerCase();
            return clean === target || clean.startsWith(target + ' ') || clean.endsWith(' ' + target);
        });
    }

    // Record that user has confirmed saving
    recordSaved(senderId) {
        const cleanId = this._normalizeId(senderId);
        if (!cleanId) return;

        if (!this.users[cleanId]) {
            this.users[cleanId] = {
                id: cleanId,
                name: 'User',
                status: 'saved',
                welcomedAt: new Date().toISOString(),
                savedAt: new Date().toISOString()
            };
        } else {
            this.users[cleanId].status = 'saved';
            this.users[cleanId].savedAt = new Date().toISOString();
        }
        this.saveUsers();
    }

    // Format template strings with variables
    formatText(template, senderName = 'Friend', senderPhone = '') {
        const cleanName = (senderName && senderName !== 'User' && senderName !== 'undefined') ? senderName.trim() : 'Friend';
        return (template || '')
            .replace(/\{name\}/gi, cleanName)
            .replace(/\{phone\}/gi, senderPhone || '');
    }

    getWelcomeMessage(senderName, senderPhone) {
        return this.formatText(this.config.welcomeMessage, senderName, senderPhone);
    }

    getSavedConfirmationMessage(senderName, senderPhone) {
        return this.formatText(this.config.savedConfirmationMessage, senderName, senderPhone);
    }

    getUsersList() {
        return Object.values(this.users).sort((a, b) => new Date(b.welcomedAt) - new Date(a.welcomedAt));
    }

    resetUser(senderId) {
        const cleanId = this._normalizeId(senderId);
        if (cleanId && this.users[cleanId]) {
            delete this.users[cleanId];
            this.saveUsers();
            return true;
        }
        return false;
    }

    clearAllUsers() {
        this.users = {};
        this.saveUsers();
        return true;
    }
}

module.exports = new WelcomeEngine();
