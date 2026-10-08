const { Module } = require('../core/handler');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- DATABASE SETUP ---
// We use a simple JSON file to remember which URL belongs to which plugin
const DB_PATH = path.join(__dirname, 'plugin_links.json');

// Helper: Save link to database
function savePluginLink(name, url) {
    let db = {};
    if (fs.existsSync(DB_PATH)) {
        try { db = JSON.parse(fs.readFileSync(DB_PATH)); } catch {}
    }
    db[name] = url;
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Helper: Get link from database
function getPluginLink(name) {
    if (!fs.existsSync(DB_PATH)) return null;
    try {
        const db = JSON.parse(fs.readFileSync(DB_PATH));
        return db[name];
    } catch { return null; }
}

// Helper: Clean URL
const getRawUrl = (url) => {
    url = url.trim();
    if (url.includes('gist.github.com') && !url.includes('/raw')) {
        return url + '/raw';
    }
    else if (url.includes('github.com') && url.includes('/blob/')) {
        return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
    }
    return url;
};

// --- CORE INSTALL LOGIC (Reused by Install & Update) ---
async function coreInstall(url, m) {
    try {
        const rawUrl = getRawUrl(url);
        
        const { data } = await axios.get(rawUrl);

        // Security Check
        if (typeof data !== 'string' || !data.includes("Module(")) {
            throw new Error("Invalid plugin code (No 'Module' found)");
        }

        // Extract Filename
        const regex = /(?:pattern|command):\s*["']([^"']+)["']/;
        const nameMatch = data.match(regex);
        // Default to timestamp if name not found, but prefer pattern name
        const rawName = nameMatch ? nameMatch[1].split(' ')[0] : "plugin_" + Date.now();
        const name = rawName.replace(/[^a-zA-Z0-9]/g, ""); // Clean filename
        
        const filePath = path.join(__dirname, `${name}.js`);

        // Fix Imports
        let content = data;
        content = content.replace(/require\(['"].*lib\/module['"]\)/g, "require('../core/handler')");
        content = content.replace(/require\(['"].*core\/handler['"]\)/g, "require('../core/handler')"); // Self-fix
        content = content.replace(/require\(['"].*main['"]\)/g, "require('../core/handler')");
        content = content.replace(/require\(['"].*config['"]\)/g, "require('../config')");
        content = content.replace(/require\(['"].*utils\/language['"]\)/g, "require('./utils/misc')");

        // Save File
        fs.writeFileSync(filePath, content);

        // Save Link to Memory (Crucial for Updates)
        savePluginLink(name, rawUrl);

        // Load Plugin
        try {
            // Delete cache to ensure fresh load
            if (require.cache[require.resolve(filePath)]) {
                delete require.cache[require.resolve(filePath)];
            }
            require(filePath);
            return { success: true, name: name };
        } catch (e) {
            fs.unlinkSync(filePath); // Delete bad file
            throw new Error(`Syntax Error: ${e.message}`);
        }

    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 1. COMMAND: INSTALL
Module({
    pattern: "install ?(.*)",
    fromMe: true,
    desc: "Install external plugins",
    usage: ".install <url>"
}, async (m, match) => {
    const url = match[1] || m.quoted?.text;
    if (!url || !url.startsWith('http')) return m.reply("❌ Provide a URL.");

    await m.reply(`⏳ Installing...`);
    const result = await coreInstall(url, m);

    if (result.success) {
        m.reply(`✅ *Installed: ${result.name}*\nLink saved for updates.`);
    } else {
        m.reply(`❌ Failed: ${result.error}`);
    }
});

// 2. COMMAND: UPDATE (The New Feature)
Module({
    pattern: "pluginupdate ?(.*)",
    fromMe: true,
    desc: "Update an existing plugin",
    usage: ".pluginupdate <name> or .pluginupdate all"
}, async (m, match) => {
    const input = match[1]?.toLowerCase().trim();
    if (!input) return m.reply("❌ Provide a plugin name (e.g., .pluginupdate menu) or .pluginupdate all");

    // A. Update ALL Plugins
    if (input === 'all') {
        if (!fs.existsSync(DB_PATH)) return m.reply("❌ No external plugins found to update.");
        
        const db = JSON.parse(fs.readFileSync(DB_PATH));
        const names = Object.keys(db);
        
        if (names.length === 0) return m.reply("❌ No plugins saved.");

        await m.reply(`⏳ Updating ${names.length} plugins...`);
        
        let successCount = 0;
        let failCount = 0;

        for (const name of names) {
            const result = await coreInstall(db[name], m);
            if (result.success) successCount++;
            else failCount++;
        }

        return m.reply(`✅ *Update Complete*\nUpdated: ${successCount}\nFailed: ${failCount}`);
    }

    // B. Update SINGLE Plugin
    const url = getPluginLink(input);
    if (!url) {
        return m.reply(`❌ No saved link found for "${input}".\n\n*Note:* If you installed this plugin before adding this update command, you must reinstall it once with the URL to save it.`);
    }

    await m.reply(`⏳ Updating *${input}* from source...`);
    const result = await coreInstall(url, m);

    if (result.success) {
        m.reply(`✅ *${result.name}* updated successfully!`);
    } else {
        m.reply(`❌ Update Failed: ${result.error}`);
    }
});

// 3. COMMAND: LIST PLUGINS (Optional Helper)
Module({
    pattern: "pluginlist",
    fromMe: true,
    desc: "List external plugins"
}, async (m) => {
    if (!fs.existsSync(DB_PATH)) return m.reply("No external plugins installed.");
    const db = JSON.parse(fs.readFileSync(DB_PATH));
    const list = Object.keys(db).map((n, i) => `${i+1}. ${n}`).join('\n');
    m.reply(`*🧩 External Plugins:*\n\n${list || "None"}`);
});
