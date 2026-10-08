const fs = require('fs');
const path = require('path');

const ANALYTICS_FILE = path.join(__dirname, '../analytics.json');

const DEFAULT_ANALYTICS = {
    totalReceived: 0,
    totalReplied: 0,
    totalAudioProcessed: 0,
    handoffCount: 0,
    estimatedTokens: 0,
    latencies: [], // Array of recent ms
    activeUsers: {}, // senderId -> count
    topTopics: {}, // keyword/topic -> count
    hourlyStats: {}, // YYYY-MM-DD-HH -> { received, replied }
    startedAt: new Date().toISOString()
};

class AnalyticsTracker {
    constructor() {
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(ANALYTICS_FILE)) {
                return { ...DEFAULT_ANALYTICS, ...JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')) };
            }
        } catch (e) {}
        return { ...DEFAULT_ANALYTICS };
    }

    save() {
        try {
            fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {}
    }

    recordMessage(senderId, isReply = false) {
        if (isReply) {
            this.data.totalReplied++;
        } else {
            this.data.totalReceived++;
            this.data.activeUsers[senderId] = (this.data.activeUsers[senderId] || 0) + 1;
        }

        const hourKey = new Date().toISOString().substring(0, 13); // e.g. 2026-10-08T04
        if (!this.data.hourlyStats[hourKey]) {
            this.data.hourlyStats[hourKey] = { received: 0, replied: 0 };
        }
        if (isReply) {
            this.data.hourlyStats[hourKey].replied++;
        } else {
            this.data.hourlyStats[hourKey].received++;
        }

        this.save();
    }

    recordAIUsage({ inputTokens = 0, outputTokens = 0, latencyMs = 0, topic = null, isAudio = false }) {
        this.data.estimatedTokens += (inputTokens + outputTokens);
        if (isAudio) this.data.totalAudioProcessed++;

        if (latencyMs > 0) {
            this.data.latencies.push(latencyMs);
            if (this.data.latencies.length > 50) this.data.latencies.shift();
        }

        if (topic) {
            const clean = topic.toLowerCase().trim();
            this.data.topTopics[clean] = (this.data.topTopics[clean] || 0) + 1;
        }

        this.save();
    }

    recordHandoff() {
        this.data.handoffCount++;
        this.save();
    }

    getStats() {
        // Compute average latency
        const avgLatency = this.data.latencies.length > 0 
            ? Math.round(this.data.latencies.reduce((a, b) => a + b, 0) / this.data.latencies.length) 
            : 0;

        // Top 5 active users
        const sortedUsers = Object.entries(this.data.activeUsers)
            .map(([id, count]) => ({ user: id.split('@')[0], count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // Top 5 topics
        const sortedTopics = Object.entries(this.data.topTopics)
            .map(([topic, count]) => ({ topic, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // Last 12 hours activity
        const recentHours = Object.entries(this.data.hourlyStats)
            .slice(-12)
            .map(([hour, val]) => ({ hour: hour.substring(11) + ':00', ...val }));

        return {
            totalReceived: this.data.totalReceived,
            totalReplied: this.data.totalReplied,
            totalAudioProcessed: this.data.totalAudioProcessed,
            handoffCount: this.data.handoffCount,
            estimatedTokens: this.data.estimatedTokens,
            avgLatencyMs: avgLatency,
            topUsers: sortedUsers,
            topTopics: sortedTopics,
            recentHours: recentHours
        };
    }
}

const analytics = new AnalyticsTracker();
module.exports = analytics;
