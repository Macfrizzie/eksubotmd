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
        this.rules = [];
        this.loadRules();
    }

    loadRules() {
        try {
            if (fs.existsSync(RULES_FILE)) {
                this.rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')) || [];
            } else {
                this.rules = [
                    {
                        id: 'rule_welcome',
                        keyword: 'hello',
                        matchType: 'contains',
                        response: 'Hello @user! 👋 How can I help you today? Ask me any questions or type .menu for commands.',
                        enabled: true,
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: 'rule_fees',
                        keyword: 'school fees',
                        matchType: 'contains',
                        response: '📌 School fees can be paid via the student portal at portal.eksu.edu.ng. Late payment penalties apply after the deadline.',
                        enabled: true,
                        createdAt: new Date().toISOString()
                    }
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
            fs.writeFileSync(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('Error saving keyword rules:', e.message);
            return false;
        }
    }

    getRules() {
        return this.rules;
    }

    addRule(keyword, matchType, response, enabled = true) {
        const id = 'kw_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 3);
        const newRule = {
            id,
            keyword: keyword.trim(),
            matchType: matchType || 'contains',
            response: response.trim(),
            enabled: enabled !== false,
            createdAt: new Date().toISOString()
        };
        this.rules.unshift(newRule);
        this.saveRules();
        return newRule;
    }

    updateRule(id, updates) {
        const idx = this.rules.findIndex(r => r.id === id);
        if (idx === -1) return null;

        this.rules[idx] = {
            ...this.rules[idx],
            ...updates,
            updatedAt: new Date().toISOString()
        };
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
        if (!userQuery || typeof userQuery !== 'string') return null;
        const text = userQuery.trim().toLowerCase();

        for (const rule of this.rules) {
            if (!rule.enabled || !rule.keyword) continue;

            const kw = rule.keyword.trim().toLowerCase();
            const type = (rule.matchType || 'contains').toLowerCase();
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
                    // Check if whole word regex matches, or Levenshtein distance is high
                    if (new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i').test(text)) {
                        isMatch = true;
                    } else {
                        // Check fuzzy similarity against each word in query
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
                        const regex = new RegExp(rule.keyword, 'i');
                        isMatch = regex.test(userQuery);
                    } catch (regexErr) {
                        console.warn(`Invalid regex pattern in rule ${rule.id}:`, regexErr.message);
                    }
                    break;

                default:
                    isMatch = text.includes(kw);
            }

            if (isMatch) {
                return {
                    ruleId: rule.id,
                    keyword: rule.keyword,
                    matchType: rule.matchType,
                    response: rule.response
                };
            }
        }

        return null;
    }
}

const keywordEngine = new KeywordEngine();
module.exports = keywordEngine;
