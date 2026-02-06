/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands for Mirror Mode
 */

const express = require('express');
const axios = require('axios');
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');

class TelegramWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('TelegramWebhook');
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null;

        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware() {
        this.app.use(express.json());
    }

    _setupRoutes() {
        this.app.post('/webhook/telegram', this._handleWebhook.bind(this));

        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'telegram-webhook' });
        });
    }

    /**
     * Generate network options for axios requests
     */
    _getNetworkOptions() {
        const options = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    async _handleWebhook(req, res) {
        try {
            const update = req.body;

            if (update.message) {
                await this._handleMessage(update.message);
            } else if (update.callback_query) {
                await this._handleCallbackQuery(update.callback_query);
            }

            res.status(200).send('OK');
        } catch (error) {
            this.logger.error('Webhook handling error:', error.message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleMessage(message) {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const messageText = message.text?.trim();

        if (!messageText) return;

        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }

        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }

        // /cmd <message> — explicit command prefix
        const commandMatch = messageText.match(/^\/cmd\s+(.+)$/is);
        if (commandMatch) {
            await this._injectDirect(chatId, commandMatch[1]);
            return;
        }

        // Any non-command text is treated as a direct command to Claude
        if (!messageText.startsWith('/')) {
            await this._injectDirect(chatId, messageText);
            return;
        }

        await this._sendMessage(chatId, '❌ Format: /cmd <your command>');
    }

    /**
     * Inject a command directly into the configured tmux session
     */
    async _injectDirect(chatId, command) {
        try {
            const tmuxSession = this.injector.defaultSession;
            await this.injector.injectCommand(command, tmuxSession);

            await this._sendMessage(chatId, `✅ ${command}`);
            this.logger.info(`Command injected - User: ${chatId}, Command: ${command}`);
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId, `❌ ${error.message}`);
        }
    }

    async _handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;

        await this._answerCallbackQuery(callbackQuery.id);

        // Handle legacy callback buttons from old notifications
        if (data.startsWith('personal:') || data.startsWith('group:') || data.startsWith('session:')) {
            await this._sendMessage(chatId,
                `📝 *Mirror Mode is active!*\n\nJust type your message directly — no token needed.\n\nOr use: \`/cmd <your command>\``,
                { parse_mode: 'Markdown' });
        }
    }

    async _sendWelcomeMessage(chatId) {
        const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `*Mirror Mode:* Just type your message and it goes directly to Claude.\n\n` +
            `Or use: \`/cmd <your command>\`\n\n` +
            `Type /help for more information.`;

        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async _sendHelpMessage(chatId) {
        const message = `📚 *Claude Code Remote Bot Help*\n\n` +
            `*Commands:*\n` +
            `• \`/start\` - Welcome message\n` +
            `• \`/help\` - Show this help\n` +
            `• \`/cmd <command>\` - Send command to Claude\n\n` +
            `*Mirror Mode:*\n` +
            `Just type any message — it will be sent directly to your Claude session.\n\n` +
            `*Example:*\n` +
            `\`analyze the performance of this function\``;

        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    _isAuthorized(userId, chatId) {
        const whitelist = this.config.whitelist || [];

        if (whitelist.includes(String(chatId)) || whitelist.includes(String(userId))) {
            return true;
        }

        // If no whitelist configured, allow the configured chat/group
        if (whitelist.length === 0) {
            const configuredChatId = this.config.chatId || this.config.groupId;
            if (configuredChatId && String(chatId) === String(configuredChatId)) {
                return true;
            }
        }

        return false;
    }

    async _getBotUsername() {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions()
            );

            if (response.data.ok && response.data.result.username) {
                this.botUsername = response.data.result.username;
                return this.botUsername;
            }
        } catch (error) {
            this.logger.error('Failed to get bot username:', error.message);
        }

        return this.config.botUsername || 'claude_remote_bot';
    }

    async _sendMessage(chatId, text, options = {}) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: text,
                    ...options
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
        }
    }

    async _answerCallbackQuery(callbackQueryId, text = '') {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/answerCallbackQuery`,
                {
                    callback_query_id: callbackQueryId,
                    text: text
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to answer callback query:', error.response?.data || error.message);
        }
    }

    async setWebhook(webhookUrl) {
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setWebhook`,
                {
                    url: webhookUrl,
                    allowed_updates: ['message', 'callback_query']
                },
                this._getNetworkOptions()
            );

            this.logger.info('Webhook set successfully:', response.data);
            return response.data;
        } catch (error) {
            this.logger.error('Failed to set webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            this.logger.info(`Telegram webhook server started on port ${port}`);
        });
    }
}

module.exports = TelegramWebhookHandler;
