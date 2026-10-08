let controller = {
    requestPairing: async () => ({ success: false, error: 'Bot not ready yet' }),
    restart: async () => ({ success: false, error: 'Bot not ready yet' })
};

function registerBotController(impl) {
    controller = { ...controller, ...impl };
}

function getBotController() {
    return controller;
}

module.exports = { registerBotController, getBotController };
