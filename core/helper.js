const axios = require('axios');
module.exports = {
    getJson: async (url) => (await axios.get(url)).data,
    getBuffer: async (url) => (await axios.get(url, { responseType: 'arraybuffer' })).data,
    sleep: (ms) => new Promise(r => setTimeout(r, ms))
};
