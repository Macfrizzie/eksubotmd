const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '../keyword_rules.json');

// Helper to escape regex special characters
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Simple Levenshtein distance similarity calculation (0.0 to 1.0)
function calculateSimilarity(s1, s2) {
    const longer = s1.length >= s2.length ? s1 : s2;
    const shorter = s1.length < s2.length ? s1 : s2;
    if (longer.length === 0) return 1.0;

    const costs = [];
    for (let i = 0; i <= longer.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= shorter.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[shorter.length] = lastValue;
    }

    return (longer.length - costs[shorter.length]) / parseFloat(longer.length);
}

class KeywordEngine {
    constructor() {
        this.enabled = true;
        this.standalone = false; // true = respond on its own (never call AI), false = hybrid (keywords + AI fallback)
        this.rules = [];
        this.loadRules();
    }

    // Normalize rule to ensure both array and scalar properties exist
    _normalizeRule(rule) {
        // Normalize keywords
        let keywords = [];
        if (Array.isArray(rule.keywords) && rule.keywords.length > 0) {
            keywords = rule.keywords.map(k => String(k).trim()).filter(Boolean);
        } else if (typeof rule.keyword === 'string') {
            keywords = rule.keyword.split(',').map(k => k.trim()).filter(Boolean);
        }
        if (keywords.length === 0 && rule.keyword) {
            keywords = [String(rule.keyword).trim()];
        }

        // Normalize responses (multi-bubble support)
        let responses = [];
        if (Array.isArray(rule.responses) && rule.responses.length > 0) {
            responses = rule.responses.map(r => String(r).trim()).filter(Boolean);
        } else if (typeof rule.response === 'string' && rule.response.trim()) {
            // Check if delimiter "---" or multiple lines was used
            responses = [rule.response.trim()];
        }
        if (responses.length === 0) {
            responses = [''];
        }

        return {
            id: rule.id || ('kw_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 3)),
            keywords,
            keyword: keywords.join(', '),
            matchType: rule.matchType || 'contains',
            responses,
            response: responses[0] || '',
            enabled: rule.enabled !== false,
            createdAt: rule.createdAt || new Date().toISOString(),
            updatedAt: rule.updatedAt || new Date().toISOString()
        };
    }

    loadRules() {
        try {
            if (fs.existsSync(RULES_FILE)) {
                const parsed = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
                if (Array.isArray(parsed)) {
                    this.enabled = true;
                    this.standalone = false;
                    this.rules = parsed.map(r => this._normalizeRule(r));
                } else if (parsed && typeof parsed === 'object') {
                    this.enabled = parsed.enabled !== undefined ? !!parsed.enabled : true;
                    this.standalone = parsed.standalone !== undefined ? !!parsed.standalone : false;
                    const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
                    this.rules = rawRules.map(r => this._normalizeRule(r));
                }
            } else {
                this.enabled = true;
                this.standalone = false;
                this.rules = [
                    this._normalizeRule({
                        id: 'rule_welcome',
                        keywords: ['hello', 'hi', 'hey'],
                        keyword: 'hello, hi, hey',
                        matchType: 'contains',
                        responses: [
                            'Hello @user! 👋 Welcome to EKSU Assistant.',
                            'How can I help you today? Ask me any questions or type *.menu* for commands.'
                        ],
                        response: 'Hello @user! 👋 Welcome to EKSU Assistant.',
                        enabled: true,
                        createdAt: new Date().toISOString()
                    }),
                    this._normalizeRule({
                        id: 'rule_fees',
                        keywords: ['school fees', 'fees', 'tuition'],
                        keyword: 'school fees, fees, tuition',
                        matchType: 'contains',
                        responses: [
                            '📌 *EKSU School Fees Notice:*\nSchool fees are paid strictly via the student portal: https://portal.eksu.edu.ng',
                            '⚠️ *Important:* Never pay to personal bank accounts. Always print your official payment receipt!'
                        ],
                        response: '📌 *EKSU School Fees Notice:*\nSchool fees are paid strictly via the student portal: https://portal.eksu.edu.ng',
                        enabled: true,
                        createdAt: new Date().toISOString()
                    })
                ];
                this.saveRules();
            }
        } catch (e) {
            console.error('Error loading keyword rules:', e.message);
            this.rules = [];
        }
        return this.rules;
    }

    saveRules() {
        try {
            const dataToSave = {
                enabled: this.enabled,
                standalone: this.standalone,
                rules: this.rules
            };
            fs.writeFileSync(RULES_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('Error saving keyword rules:', e.message);
            return false;
        }
    }

    getConfig() {
        return {
            enabled: this.enabled,
            standalone: this.standalone
        };
    }

    updateConfig({ enabled, standalone }) {
        if (enabled !== undefined) this.enabled = !!enabled;
        if (standalone !== undefined) this.standalone = !!standalone;
        this.saveRules();
        return this.getConfig();
    }

    getState() {
        return {
            enabled: this.enabled,
            standalone: this.standalone,
            rules: this.rules
        };
    }

    getRules() {
        return this.rules;
    }

    addRule(keywordsInput, matchType, responsesInput, enabled = true) {
        const id = 'kw_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 3);
        const newRule = this._normalizeRule({
            id,
            keywords: Array.isArray(keywordsInput) ? keywordsInput : String(keywordsInput || '').split(','),
            matchType: matchType || 'contains',
            responses: Array.isArray(responsesInput) ? responsesInput : [String(responsesInput || '')],
            enabled: enabled !== false,
            createdAt: new Date().toISOString()
        });

        this.rules.unshift(newRule);
        this.saveRules();
        return newRule;
    }

    updateRule(id, updates) {
        const idx = this.rules.findIndex(r => r.id === id);
        if (idx === -1) return null;

        const merged = {
            ...this.rules[idx],
            ...updates,
            updatedAt: new Date().toISOString()
        };

        this.rules[idx] = this._normalizeRule(merged);
        this.saveRules();
        return this.rules[idx];
    }

    deleteRule(id) {
        const initialLen = this.rules.length;
        this.rules = this.rules.filter(r => r.id !== id);
        this.saveRules();
        return this.rules.length < initialLen;
    }

    // Match query against rules
    findMatch(userQuery) {
        if (!this.enabled) return null;
        if (!userQuery || typeof userQuery !== 'string') return null;
        const text = userQuery.trim().toLowerCase();

        for (const rule of this.rules) {
            if (!rule.enabled) continue;

            // Extract keyword list to test
            const kwList = (Array.isArray(rule.keywords) && rule.keywords.length > 0)
                ? rule.keywords
                : (typeof rule.keyword === 'string' ? rule.keyword.split(',').map(s => s.trim()).filter(Boolean) : []);

            if (kwList.length === 0) continue;

            const type = (rule.matchType || 'contains').toLowerCase();
            let matchedKw = null;

            for (const rawKw of kwList) {
                const kw = rawKw.toLowerCase().trim();
                if (!kw) continue;

                let isMatch = false;

                switch (type) {
                    case 'exact':
                        isMatch = (text === kw);
                        break;

                    case 'startswith':
                    case 'starts with':
                        isMatch = text.startsWith(kw);
                        break;

                    case 'endswith':
                    case 'ends with':
                        isMatch = text.endsWith(kw);
                        break;

                    case 'contains':
                        isMatch = text.includes(kw);
                        break;

                    case 'similar':
                    case 'fuzzy':
                        if (new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i').test(text)) {
                            isMatch = true;
                        } else {
                            const queryWords = text.split(/\s+/);
                            for (const word of queryWords) {
                                if (calculateSimilarity(word, kw) >= 0.72) {
                                    isMatch = true;
                                    break;
                                }
                            }
                        }
                        break;

                    case 'regex':
                        try {
                            const regex = new RegExp(kw, 'i');
                            isMatch = regex.test(userQuery);
                        } catch (regexErr) {
                            console.warn(`Invalid regex pattern in rule ${rule.id}:`, regexErr.message);
                        }
                        break;

                    default:
                        isMatch = text.includes(kw);
                }

                if (isMatch) {
                    matchedKw = rawKw;
                    break;
                }
            }

            if (matchedKw !== null) {
                const responses = (Array.isArray(rule.responses) && rule.responses.length > 0)
                    ? rule.responses
                    : [rule.response || ''];

                return {
                    ruleId: rule.id,
                    matchedKeyword: matchedKw,
                    keywords: kwList,
                    matchType: rule.matchType,
                    responses,
                    response: responses[0] || ''
                };
            }
        }

        return null;
    }
}

const keywordEngine = new KeywordEngine();
module.exports = keywordEngine;
