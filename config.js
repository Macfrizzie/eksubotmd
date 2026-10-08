require('dotenv').config();

module.exports = {
    // Bot Settings
    PREFIX: process.env.PREFIX || '.',
    BOT_NAME: process.env.BOT_NAME || 'Eksu-MD',
    
    // Owner Settings
    OWNER_NUMBERS: (process.env.OWNER_NUMBERS || '').split(',').filter(n => n.trim()),
    OWNER_NAME: process.env.OWNER_NAME || 'Owner',
    
    // Database (if needed)
    DATABASE_URL: process.env.DATABASE_URL || '',
    
    // API Keys
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    ACRCLOUD_KEY: process.env.ACRCLOUD_KEY || '',
    ACRCLOUD_SECRET: process.env.ACRCLOUD_SECRET || '',
    ACRCLOUD_HOST: process.env.ACRCLOUD_HOST || '',
    
    // Other Settings
    AUTO_READ: process.env.AUTO_READ === 'true',
    AUTO_TYPING: process.env.AUTO_TYPING === 'true',
    MODE: process.env.MODE || 'public', // public or private
};