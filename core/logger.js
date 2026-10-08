const EventEmitter = require('events');

class BotLogger extends EventEmitter {
    constructor() {
        super();
        this.logHistory = [];
        this.maxHistory = 300;
        this.status = {
            connected: false,
            connecting: false,
            pairingCode: null,
            user: null,
            startTime: Date.now()
        };
        this.setupConsoleIntercept();
    }

    setupConsoleIntercept() {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        console.log = (...args) => {
            originalLog(...args);
            this.pushLog('info', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
        };

        console.warn = (...args) => {
            originalWarn(...args);
            this.pushLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
        };

        console.error = (...args) => {
            originalError(...args);
            this.pushLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
        };
    }

    pushLog(level, message) {
        const entry = {
            id: Date.now() + Math.random().toString(36).substr(2, 4),
            level,
            message,
            timestamp: new Date().toLocaleTimeString()
        };

        this.logHistory.push(entry);
        if (this.logHistory.length > this.maxHistory) {
            this.logHistory.shift();
        }

        this.emit('log', entry);
    }

    setStatus(update) {
        this.status = { ...this.status, ...update };
        this.emit('status', this.status);
    }

    getStatus() {
        return {
            ...this.status,
            uptime: Math.floor((Date.now() - this.status.startTime) / 1000)
        };
    }

    getLogs() {
        return this.logHistory;
    }

    clearLogs() {
        this.logHistory = [];
        this.emit('clear');
    }
}

const logger = new BotLogger();
module.exports = logger;
