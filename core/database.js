const fs = require('fs');
const path = require('path');
require('dotenv').config();

const dbPath = path.join(__dirname, '../database.json');
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({}, null, 2));

const readDb = () => JSON.parse(fs.readFileSync(dbPath, 'utf8') || '{}');
const writeDb = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

const BotVariable = {
    upsert: async ({ key, value }) => {
        const db = readDb();
        db[key] = value;
        writeDb(db);
        return true;
    },
    findOne: async ({ where }) => {
        const db = readDb();
        return db[where.key] ? { dataValues: { value: db[where.key] } } : null;
    },
    findAll: async () => {
        const db = readDb();
        return Object.keys(db).map(k => ({ dataValues: { key: k, value: db[k] } }));
    },
    destroy: async ({ where }) => {
        const db = readDb();
        if (db[where.key]) { delete db[where.key]; writeDb(db); }
        return true;
    }
};

module.exports = { 
    BotVariable, 
    setVar: (k, v) => BotVariable.upsert({ key: k, value: v }), 
    getVar: async (k) => (await BotVariable.findOne({ where: { key: k } }))?.dataValues.value 
};
