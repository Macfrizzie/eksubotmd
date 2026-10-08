const config = require('../config');
const commands = [];
const listeners = [];

function Module(info, func) {
    const plugin = { 
        ...info, 
        function: func,
        pattern: info.pattern || null,
        on: info.on || null,
        fromMe: info.fromMe || false 
    };

    if (info.pattern) {
        const prefix = (config.HANDLERS && config.HANDLERS !== 'false') ? config.HANDLERS : '.';
        
        if (typeof info.pattern === 'string') {
            const cleanPattern = info.pattern.replace(/^\^/, '').replace(/\\/g, '');
            
            // 👇👇 THE FIX IS HERE (Changed 'i' to 'is') 👇👇
            // The 's' flag tells the bot: "Treat new lines as part of the message"
            plugin.pattern = new RegExp(`^\\${prefix}${cleanPattern}`, 'is'); 
            
            plugin.cmdName = cleanPattern.split(' ')[0].replace(/[^a-zA-Z0-9]/g, '');
        }
        commands.push(plugin);
    } 
    else if (info.on) {
        listeners.push(plugin);
    }
}

module.exports = { Module, commands, listeners };
