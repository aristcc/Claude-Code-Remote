/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API with HTML formatting and auto-fallback
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class TelegramChannel extends NotificationChannel {
    constructor(config = {}) {
        super('telegram', config);
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null;

        this._validateConfig();
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

        // Generate Telegram messages (may be multiple for long responses)
        const messageTexts = this._generateTelegramMessages(notification);

        // Determine recipient (chat or group)
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

    _escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

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

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = TelegramChannel;
