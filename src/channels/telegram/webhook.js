/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands
 * Supports both token-based (default) and mirror mode (tokenless) operation
 */

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');

class TelegramWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.mirrorMode = process.env.MIRROR_MODE === 'true';
        this.logger = new Logger('TelegramWebhook');
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null;

        if (!this.mirrorMode) {
            this.sessionsDir = path.join(__dirname, '../../data/sessions');
        }

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

        if (this.mirrorMode) {
            await this._handleMirrorMessage(chatId, messageText);
        } else {
            await this._handleTokenMessage(chatId, messageText);
        }
    }

    // ── Mirror Mode Message Handling ────────────────────────────────

    async _handleMirrorMessage(chatId, messageText) {
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

    // ── Token Mode Message Handling ─────────────────────────────────

    async _handleTokenMessage(chatId, messageText) {
        // /cmd TOKEN command
        const commandMatch = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (commandMatch) {
            await this._processTokenCommand(chatId, commandMatch[1].toUpperCase(), commandMatch[2]);
            return;
        }

        // TOKEN command (without /cmd prefix)
        const directMatch = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/);
        if (directMatch) {
            await this._processTokenCommand(chatId, directMatch[1].toUpperCase(), directMatch[2]);
            return;
        }

        await this._sendMessage(chatId,
            '❌ Invalid format. Use:\n`/cmd <TOKEN> <command>`\n\nExample:\n`/cmd ABC12345 analyze this code`',
            { parse_mode: 'Markdown' });
    }

    async _processTokenCommand(chatId, token, command) {
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._sendMessage(chatId,
                '❌ Invalid or expired token. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            return;
        }

        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId,
                '❌ Token has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await this._removeSession(session.id);
            return;
        }

        try {
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);

            await this._sendMessage(chatId,
                `✅ *Command sent successfully*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                { parse_mode: 'Markdown' });

            this.logger.info(`Command injected - User: ${chatId}, Token: ${token}, Command: ${command}`);
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId,
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _findSessionByToken(token) {
        if (!this.sessionsDir) return null;

        let files;
        try {
            files = fs.readdirSync(this.sessionsDir);
        } catch (error) {
            this.logger.error('Failed to read sessions directory:', error.message);
            return null;
        }

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error) {
                this.logger.error(`Failed to read session file ${file}:`, error.message);
            }
        }

        return null;
    }

    async _removeSession(sessionId) {
        if (!this.sessionsDir) return;

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    // ── Callback Query Handling ─────────────────────────────────────

    async _handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;

        await this._answerCallbackQuery(callbackQuery.id);

        if (this.mirrorMode) {
            // Mirror mode: buttons are legacy, inform user to type directly
            if (data.startsWith('personal:') || data.startsWith('group:') || data.startsWith('session:')) {
                await this._sendMessage(chatId,
                    `📝 *Mirror Mode is active!*\n\nJust type your message directly — no token needed.\n\nOr use: \`/cmd <your command>\``,
                    { parse_mode: 'Markdown' });
            }
        } else {
            // Token mode: show command format with the token
            if (data.startsWith('personal:')) {
                const token = data.split(':')[1];
                await this._sendMessage(chatId,
                    `📝 *Personal Chat Command Format:*\n\n\`/cmd ${token} <your command>\`\n\n*Example:*\n\`/cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                    { parse_mode: 'Markdown' });
            } else if (data.startsWith('group:')) {
                const token = data.split(':')[1];
                const botUsername = await this._getBotUsername();
                await this._sendMessage(chatId,
                    `👥 *Group Chat Command Format:*\n\n\`@${botUsername} /cmd ${token} <your command>\`\n\n*Example:*\n\`@${botUsername} /cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                    { parse_mode: 'Markdown' });
            } else if (data.startsWith('session:')) {
                const token = data.split(':')[1];
                await this._sendMessage(chatId,
                    `📝 *How to send a command:*\n\nType:\n\`/cmd ${token} <your command>\`\n\nExample:\n\`/cmd ${token} please analyze this code\`\n\n💡 *Tip:* New notifications have a button that auto-fills the command for you!`,
                    { parse_mode: 'Markdown' });
            }
        }
    }

    // ── Welcome / Help Messages ─────────────────────────────────────

    async _sendWelcomeMessage(chatId) {
        if (this.mirrorMode) {
            const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
                `I'll notify you when Claude completes tasks or needs input.\n\n` +
                `*Mirror Mode:* Just type your message and it goes directly to Claude.\n\n` +
                `Or use: \`/cmd <your command>\`\n\n` +
                `Type /help for more information.`;
            await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } else {
            const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
                `I'll notify you when Claude completes tasks or needs input.\n\n` +
                `When you receive a notification with a token, you can send commands back using:\n` +
                `\`/cmd <TOKEN> <your command>\`\n\n` +
                `Type /help for more information.`;
            await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
    }

    async _sendHelpMessage(chatId) {
        if (this.mirrorMode) {
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
        } else {
            const message = `📚 *Claude Code Remote Bot Help*\n\n` +
                `*Commands:*\n` +
                `• \`/start\` - Welcome message\n` +
                `• \`/help\` - Show this help\n` +
                `• \`/cmd <TOKEN> <command>\` - Send command to Claude\n\n` +
                `*Example:*\n` +
                `\`/cmd ABC12345 analyze the performance of this function\`\n\n` +
                `*Tips:*\n` +
                `• Tokens are case-insensitive\n` +
                `• Tokens expire after 24 hours\n` +
                `• You can also just type \`TOKEN command\` without /cmd`;
            await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
    }

    // ── Utility Methods ─────────────────────────────────────────────

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
