#!/usr/bin/env node

/**
 * Claude PostToolUse Hook - sends each tool call to Telegram in real-time
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Load .env
const dotenv = require('dotenv');
const envPath = path.join(path.dirname(__filename), '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) process.exit(0);

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (r) => { if (!resolved) { resolved = true; resolve(r); } };
        if (process.stdin.isTTY) { done({}); return; }
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); } catch (e) { done({}); }
        });
        process.stdin.on('error', () => { done({}); });
        setTimeout(() => done({}), 2000);
    });
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatToolMessage(input) {
    const tool = input.tool_name || 'Unknown';
    const toolInput = input.tool_input || {};
    const toolResponse = input.tool_response || {};

    let icon = '🔧';
    let summary = '';

    switch (tool) {
        case 'Bash':
            icon = '💻';
            summary = toolInput.command || '';
            break;
        case 'Read':
            icon = '📖';
            summary = toolInput.file_path || '';
            break;
        case 'Write':
            icon = '✏️';
            summary = toolInput.file_path || '';
            break;
        case 'Edit':
            icon = '📝';
            summary = toolInput.file_path || '';
            break;
        case 'Grep':
            icon = '🔍';
            summary = `"${toolInput.pattern || ''}" ${toolInput.path || ''}`;
            break;
        case 'Glob':
            icon = '📂';
            summary = toolInput.pattern || '';
            break;
        case 'Task':
            icon = '🤖';
            summary = toolInput.description || '';
            break;
        case 'WebSearch':
            icon = '🌐';
            summary = toolInput.query || '';
            break;
        case 'WebFetch':
            icon = '🌐';
            summary = toolInput.url || '';
            break;
        default:
            summary = JSON.stringify(toolInput).substring(0, 200);
    }

    // Truncate summary
    if (summary.length > 300) {
        summary = summary.substring(0, 300) + '...';
    }

    // Get brief result
    let result = '';
    if (tool === 'Bash') {
        const stdout = toolResponse.stdout || toolResponse.output || '';
        if (stdout) {
            result = String(stdout).substring(0, 500);
            if (String(stdout).length > 500) result += '...';
        }
    } else if (tool === 'Grep') {
        const matches = toolResponse.match_count || toolResponse.numMatches || '';
        if (matches) result = `${matches} matches`;
    }

    let msg = `${icon} <b>${escapeHtml(tool)}</b>\n${escapeHtml(summary)}`;
    if (result) {
        msg += `\n<pre>${escapeHtml(result)}</pre>`;
    }

    return msg;
}

async function sendToTelegram(text) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_notification: true },
            { timeout: 5000, family: 4 }
        );
    } catch (e) {
        // Fallback to plain text
        try {
            await axios.post(
                `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                { chat_id: CHAT_ID, text: text.replace(/<[^>]+>/g, ''), disable_notification: true },
                { timeout: 5000, family: 4 }
            );
        } catch (e2) {
            // silently fail
        }
    }
}

async function main() {
    const input = await readStdin();
    if (!input.tool_name) process.exit(0);

    const message = formatToolMessage(input);
    await sendToTelegram(message);
}

main().catch(() => process.exit(0));
