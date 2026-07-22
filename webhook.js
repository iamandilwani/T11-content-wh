// server/webhook.js
// Stage 2: real DM handling.
// - Checks opt-out keywords first, always honored.
// - Sends a disclosed auto-reply (once per sender) within Meta's rules.
// - Notifies your Telegram whenever a real DM comes in.
//
// NOTE ON PERSISTENCE: "seenSenders" and "optedOut" are in-memory only.
// Render's free tier can restart/sleep the server, which resets this list —
// meaning a returning user might see the disclosure line again after a
// restart. Fine for an MVP; if this matters long-term, swap these Sets for
// a small persistent store (e.g. a free Postgres/Redis add-on).

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

// TEMPORARY DIAGNOSTIC: log every single incoming request, no matter the path.
app.use((req, res, next) => {
  console.log(`🔎 ${req.method} ${req.url}`);
  next();
});

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const seenSenders = new Set();
const optedOut = new Set();

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'opt out', 'opt-out'];
const DISCLOSURE = "Hi! This is Traveleleven's automated assistant 👋 ";
const DEFAULT_REPLY =
  "Thanks for reaching out! I'll make sure a real human sees this and gets back to you soon. In the meantime, feel free to check out the latest posts on the grid!";
const OPT_OUT_CONFIRM = "Got it — you won't receive any more automated replies from this account.";

async function sendInstagramReply(recipientId, text) {
  const url = `https://graph.instagram.com/v21.0/me/messages?access_token=${IG_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('❌ Failed to send Instagram reply:', JSON.stringify(data));
  }
  return data;
}

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('❌ Failed to notify Telegram:', err.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed — token mismatch');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately, process after
  console.log('📦 RAW BODY:', JSON.stringify(req.body));

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        const senderId = event.sender?.id;
        const messageText = event.message?.text;
        if (!senderId || !messageText) continue;

        console.log(`📩 DM from ${senderId}: ${messageText}`);

        // Hard rule: opt-out is always honored, no exceptions.
        if (OPT_OUT_WORDS.some((w) => messageText.toLowerCase().includes(w))) {
          optedOut.add(senderId);
          await sendInstagramReply(senderId, OPT_OUT_CONFIRM);
          await notifyTelegram(`🚫 ${senderId} opted out of DM automation.`);
          continue;
        }

        if (optedOut.has(senderId)) {
          console.log(`Skipping reply — ${senderId} previously opted out.`);
          continue;
        }

        const isFirstContact = !seenSenders.has(senderId);
        seenSenders.add(senderId);

        const reply = isFirstContact ? DISCLOSURE + DEFAULT_REPLY : DEFAULT_REPLY;
        await sendInstagramReply(senderId, reply);

        await notifyTelegram(
          `💬 <b>New DM</b>\nFrom: ${senderId}\nMessage: ${messageText.slice(0, 200)}`
        );
      }
    }
  } catch (err) {
    console.error('❌ Error processing webhook event:', err.message);
  }
});

app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head><title>Privacy Policy — Traveleleven Content Agent</title></head>
      <body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.6;">
        <h1>Privacy Policy</h1>
        <p>This application ("Traveleleven Content Agent") is a personal automation tool used to manage
        direct messages for the Instagram account @traveleleven.in.</p>
        <p>When someone sends a direct message to @traveleleven.in, this app may receive that message
        via Meta's Instagram Messaging API in order to send an automated acknowledgment reply. No message
        content is sold, shared with third parties, or used for advertising. Messages are used solely to
        provide a timely response to the sender.</p>
        <p>Users can stop automated replies at any time by sending "stop" or "unsubscribe" in their message.</p>
        <p>For questions about this policy, contact the account owner via Instagram DM at @traveleleven.in.</p>
      </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  res.send('Content agent webhook server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

