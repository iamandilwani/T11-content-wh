// server/webhook.js
// Stage 1: just handles Meta's webhook verification handshake.
// We'll add real DM-handling logic in stage 2, after this is confirmed working.

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;

// Meta calls this with GET to verify the endpoint when you save the Callback URL.
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

// Meta will POST real events here once verified — stage 2 adds handling.
app.post('/webhook', (req, res) => {
  console.log('📩 Incoming event:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200); // must ack quickly or Meta retries/backs off
});

app.get('/', (req, res) => {
  res.send('Content agent webhook server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
