/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API
 * Supports both token-based (default) and mirror mode (tokenless) operation
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class TelegramChannel extends NotificationChannel {
    constructor(config = {}) {
        super('telegram', config);
        this.mirrorMode = process.env.MIRROR_MODE === 'true';
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null;

        if (!this.mirrorMode) {
            this.sessionsDir = path.join(__dirname, '../../data/sessions');
            this._ensureDirectories();
        }

        this._validateConfig();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig() {
        if (!this.config.botToken) {
            this.logger.warn('Telegram Bot Token not found');
            return false;
        }
        if (!this.config.chatId && !this.config.groupId) {
            this.logger.warn('Telegram Chat ID or Group ID must be configured');
            return false;
        }
        return true;
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

    _generateToken() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
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

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('Telegram channel not properly configured');
        }

        // Get tmux conversation content if metadata not already provided
        if (!notification.metadata || (!notification.metadata.claudeResponse && !notification.metadata.userQuestion)) {
            try {
                const tmuxSession = execSync('tmux display-message -p "#S"', {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim();
                if (tmuxSession) {
                    const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
                    notification.metadata = {
                        userQuestion: conversation.userQuestion || notification.message,
                        claudeResponse: conversation.claudeResponse || notification.message,
                        tmuxSession: tmuxSession
                    };
                }
            } catch (error) {
                // Not in tmux or tmux not available
            }
        }

        if (this.mirrorMode) {
            return this._sendMirrorMode(notification);
        } else {
            return this._sendTokenMode(notification);
        }
    }

    /**
     * Mirror mode: send full response as HTML with chunking, no buttons
     */
    async _sendMirrorMode(notification) {
        const messageTexts = this._generateTelegramMessages(notification);
        const chatId = this.config.groupId || this.config.chatId;

        try {
            for (let i = 0; i < messageTexts.length; i++) {
                const isLast = i === messageTexts.length - 1;
                const requestData = {
                    chat_id: chatId,
                    text: messageTexts[i]
                };

                // Use HTML parse_mode with plain text fallback
                try {
                    await axios.post(
                        `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                        { ...requestData, parse_mode: 'HTML' },
                        this._getNetworkOptions()
                    );
                } catch (htmlError) {
                    if (htmlError.response?.data?.description?.includes("can't parse entities")) {
                        this.logger.warn('HTML parse failed, sending as plain text');
                        await axios.post(
                            `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                            requestData,
                            this._getNetworkOptions()
                        );
                    } else {
                        throw htmlError;
                    }
                }

                // Small delay between messages to maintain order
                if (!isLast) await new Promise(r => setTimeout(r, 300));
            }

            this.logger.info(`Telegram message sent successfully (${messageTexts.length} parts)`);
            return true;
        } catch (error) {
            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            return false;
        }
    }

    /**
     * Token mode: send notification with session token and inline keyboard buttons
     */
    async _sendTokenMode(notification) {
        const sessionId = uuidv4();
        const token = this._generateToken();

        await this._createSession(sessionId, notification, token);

        const messageText = this._generateTokenMessage(notification, token);
        const chatId = this.config.groupId || this.config.chatId;

        const buttons = [
            [
                {
                    text: '📝 Personal Chat',
                    callback_data: `personal:${token}`
                },
                {
                    text: '👥 Group Chat',
                    callback_data: `group:${token}`
                }
            ]
        ];

        const requestData = {
            chat_id: chatId,
            text: messageText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        };

        try {
            try {
                await axios.post(
                    `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                    requestData,
                    this._getNetworkOptions()
                );
            } catch (mdError) {
                if (mdError.response?.data?.description?.includes("can't parse entities")) {
                    this.logger.warn('Markdown parse failed, sending as plain text');
                    delete requestData.parse_mode;
                    await axios.post(
                        `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                        requestData,
                        this._getNetworkOptions()
                    );
                } else {
                    throw mdError;
                }
            }

            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error) {
            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            await this._removeSession(sessionId);
            return false;
        }
    }

    _escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Generate message for token mode (Markdown, truncated summary)
     */
    _generateTokenMessage(notification, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        let messageText = `${emoji} *Claude Task ${status}*\n`;
        messageText += `*Project:* ${notification.project}\n`;
        messageText += `*Session Token:* \`${token}\`\n\n`;

        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                messageText += `📝 *Your Question:*\n${notification.metadata.userQuestion.substring(0, 200)}`;
                if (notification.metadata.userQuestion.length > 200) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }

            if (notification.metadata.claudeResponse) {
                messageText += `🤖 *Claude Response:*\n${notification.metadata.claudeResponse.substring(0, 300)}`;
                if (notification.metadata.claudeResponse.length > 300) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
        }

        messageText += `💬 *To send a new command:*\n`;
        messageText += `Reply with: \`/cmd ${token} <your command>\`\n`;
        messageText += `Example: \`/cmd ${token} Please analyze this code\``;

        return messageText;
    }

    /**
     * Generate messages for mirror mode (HTML, full response with chunking)
     */
    _generateTelegramMessages(notification) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';

        let header = `${emoji} ${this._escapeHtml(notification.project)}`;

        const userQ = notification.metadata?.userQuestion || '';
        if (userQ) {
            header += `\n\n<b>Q:</b> ${this._escapeHtml(userQ.substring(0, 300))}`;
        }

        const messages = [];
        const claudeResponse = (notification.metadata && notification.metadata.claudeResponse) || '';

        if (!claudeResponse) {
            messages.push(header);
            return messages;
        }

        const escaped = this._escapeHtml(claudeResponse);
        const maxResponsePerMsg = 3800;
        const responseChunks = [];

        for (let i = 0; i < escaped.length; i += maxResponsePerMsg) {
            responseChunks.push(escaped.substring(i, i + maxResponsePerMsg));
        }

        if (responseChunks.length === 1) {
            messages.push(header + `\n\n${responseChunks[0]}`);
        } else {
            messages.push(header + `\n\n${responseChunks[0]}`);
            for (let i = 1; i < responseChunks.length - 1; i++) {
                messages.push(`(${i + 1}/${responseChunks.length})\n${responseChunks[i]}`);
            }
            const lastIdx = responseChunks.length - 1;
            messages.push(`(${lastIdx + 1}/${responseChunks.length})\n${responseChunks[lastIdx]}`);
        }

        return messages;
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'telegram',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            tmuxSession: notification.metadata?.tmuxSession || 'default',
            project: notification.project,
            notification: notification
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

        this.logger.debug(`Session created: ${sessionId}`);
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = TelegramChannel;
