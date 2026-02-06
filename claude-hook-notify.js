#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks to send Telegram notifications
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables from the project directory
const projectDir = path.dirname(__filename);
const envPath = path.join(projectDir, '.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    console.error('.env file not found at:', envPath);
    process.exit(1);
}

const TelegramChannel = require('./src/channels/telegram/telegram');
const DesktopChannel = require('./src/channels/local/desktop');
const EmailChannel = require('./src/channels/email/smtp');

/**
 * Read stdin JSON from Claude Code hook
 */
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (result) => {
            if (!resolved) {
                resolved = true;
                resolve(result);
            }
        };
        if (process.stdin.isTTY) {
            done({});
            return;
        }
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); } catch (e) { done({}); }
        });
        process.stdin.on('error', () => { done({}); });
        setTimeout(() => done({}), 2000);
    });
}

/**
 * Extract the full last turn from transcript file.
 * Includes tool calls, results, and final response.
 */
function extractLastResponse(transcriptPath) {
    try {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        // Find the last user message index
        let lastUserIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'human' || entry.type === 'user') {
                    lastUserIdx = i;
                    break;
                }
            } catch (e) { continue; }
        }

        if (lastUserIdx === -1) return null;

        // Extract user prompt
        let userQuestion = '';
        try {
            const userEntry = JSON.parse(lines[lastUserIdx]);
            const content = userEntry.message?.content;
            if (typeof content === 'string') {
                userQuestion = content;
            } else if (Array.isArray(content)) {
                const textBlocks = content
                    .filter(b => typeof b === 'string' || b.type === 'text')
                    .map(b => typeof b === 'string' ? b : b.text);
                userQuestion = textBlocks.join('\n');
            }
        } catch (e) {}

        // Collect ALL assistant messages after the last user message
        const details = [];
        for (let i = lastUserIdx + 1; i < lines.length; i++) {
            try {
                const entry = JSON.parse(lines[i]);

                if (entry.type === 'assistant' && entry.message?.content) {
                    for (const block of entry.message.content) {
                        if (block.type === 'text' && block.text) {
                            details.push(block.text);
                        }
                        if (block.type === 'tool_use') {
                            const toolName = block.name || 'unknown';
                            const input = block.input || {};
                            let summary = `[Tool: ${toolName}]`;

                            if (toolName === 'Bash' && input.command) {
                                summary += ` $ ${input.command}`;
                            } else if (toolName === 'Read' && input.file_path) {
                                summary += ` ${input.file_path}`;
                            } else if (toolName === 'Write' && input.file_path) {
                                summary += ` ${input.file_path}`;
                            } else if (toolName === 'Edit' && input.file_path) {
                                summary += ` ${input.file_path}`;
                            } else if (toolName === 'Grep' && input.pattern) {
                                summary += ` "${input.pattern}"`;
                            } else if (toolName === 'Glob' && input.pattern) {
                                summary += ` ${input.pattern}`;
                            } else if (toolName === 'Task') {
                                summary += ` ${input.description || ''}`;
                            } else if (input.description) {
                                summary += ` ${input.description}`;
                            }
                            details.push(summary);
                        }
                    }
                }

                // Include tool results (abbreviated)
                if (entry.type === 'tool_result' || entry.type === 'tool') {
                    const resultContent = entry.message?.content || entry.content;
                    if (Array.isArray(resultContent)) {
                        for (const block of resultContent) {
                            if (block.type === 'text' && block.text) {
                                const text = block.text.substring(0, 500);
                                details.push(`[Result] ${text}${block.text.length > 500 ? '...' : ''}`);
                            }
                        }
                    }
                }
            } catch (e) { continue; }
        }

        const claudeResponse = details.join('\n\n');
        return { userQuestion, claudeResponse };
    } catch (error) {
        console.error('Failed to read transcript:', error.message);
        return null;
    }
}

async function sendHookNotification() {
    try {
        // Read hook input from stdin
        const hookInput = await readStdin();

        // Get notification type from command line argument
        const notificationType = process.argv[2] || 'completed';

        const channels = [];
        const results = [];

        // Configure Desktop channel (always enabled for sound)
        const desktopChannel = new DesktopChannel({
            completedSound: 'Glass',
            waitingSound: 'Tink'
        });
        channels.push({ name: 'Desktop', channel: desktopChannel });

        // Configure Telegram channel if enabled
        if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                groupId: process.env.TELEGRAM_GROUP_ID
            };

            if (telegramConfig.botToken && (telegramConfig.chatId || telegramConfig.groupId)) {
                const telegramChannel = new TelegramChannel(telegramConfig);
                channels.push({ name: 'Telegram', channel: telegramChannel });
            }
        }

        // Configure Email channel if enabled
        if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
            const emailConfig = {
                smtp: {
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                },
                from: process.env.EMAIL_FROM,
                fromName: process.env.EMAIL_FROM_NAME,
                to: process.env.EMAIL_TO
            };

            if (emailConfig.smtp.host && emailConfig.smtp.auth.user && emailConfig.to) {
                const emailChannel = new EmailChannel(emailConfig);
                channels.push({ name: 'Email', channel: emailChannel });
            }
        }

        // Get current working directory and tmux session
        const currentDir = hookInput.cwd || process.cwd();
        const projectName = path.basename(currentDir);

        // Try to get current tmux session
        let tmuxSession = process.env.TMUX_SESSION || 'claude-code';
        try {
            const { execSync } = require('child_process');
            const sessionOutput = execSync('tmux display-message -p "#{session_name}:#{window_name}"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (sessionOutput) {
                tmuxSession = sessionOutput;
            }
        } catch (error) {
            // Not in tmux or tmux not available, use default
        }

        // Extract conversation from transcript
        let metadata = { tmuxSession };
        const transcript = extractLastResponse(hookInput.transcript_path);
        if (transcript) {
            metadata.userQuestion = transcript.userQuestion;
            metadata.claudeResponse = transcript.claudeResponse;
        }

        // Create notification
        const notification = {
            type: notificationType,
            title: `Claude ${notificationType === 'completed' ? 'Task Completed' : 'Waiting for Input'}`,
            message: `Claude has ${notificationType === 'completed' ? 'completed a task' : 'is waiting for input'}`,
            project: projectName,
            metadata: metadata
        };

        // Send notifications to all configured channels
        for (const { name, channel } of channels) {
            try {
                const result = await channel.send(notification);
                results.push({ name, success: result });
            } catch (error) {
                console.error(`${name} notification error:`, error.message);
                results.push({ name, success: false, error: error.message });
            }
        }

        // Report overall results
        const successful = results.filter(r => r.success).length;
        const total = results.length;

        if (successful > 0) {
            console.log(`Notifications sent via ${successful}/${total} channels`);
        } else {
            console.error('All notification channels failed');
            process.exit(1);
        }

    } catch (error) {
        console.error('Hook notification error:', error.message);
        process.exit(1);
    }
}

// Show usage if no arguments
if (process.argv.length < 2) {
    console.log('Usage: node claude-hook-notify.js [completed|waiting]');
    process.exit(1);
}

sendHookNotification();
