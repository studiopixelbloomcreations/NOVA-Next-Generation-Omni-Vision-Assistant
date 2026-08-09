#!/usr/bin/env node
// Raw probe: opens a Gemini Live session and dumps the exact part mime types
// the server sends for a spoken-answer turn (to verify the bridge's audio
// mime detection matches reality).
const WebSocket = require('ws');

const key = (process.env.GEMINI_API_KEY || '').trim();
const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;

const ws = new WebSocket(endpoint);
const seen = new Set();

ws.on('open', () => {
  ws.send(JSON.stringify({
    setup: {
      model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Gacrux' } } },
      },
      systemInstruction: { parts: [{ text: 'You are NOVA. Reply briefly.' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }));
});

ws.on('message', (raw) => {
  const payload = JSON.parse(raw.toString('utf8'));
  if (payload.setupComplete) {
    console.log('SETUP COMPLETE');
    ws.send(JSON.stringify({ realtimeInput: { text: 'Say the word AUDIO_OK out loud, then stop.' } }));
    setTimeout(() => ws.close(), 20000);
  }
  const parts = payload?.serverContent?.modelTurn?.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const mime = p?.inlineData?.mimeType;
      if (mime) {
        if (!seen.has(mime)) {
          seen.add(mime);
          console.log('PART MIME:', mime, 'dataLen:', String(p.inlineData.data || '').length);
        } else {
          console.log('PART MIME (repeated):', mime);
        }
      }
      if (p?.text) console.log('TEXT:', JSON.stringify(p.text.slice(0, 120)));
    }
  }
  if (payload?.serverContent?.turnComplete) {
    console.log('TURN COMPLETE');
    ws.close();
    process.exit(0);
  }
  if (payload?.error) {
    console.error('ERROR:', JSON.stringify(payload.error));
    process.exit(1);
  }
});

ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
ws.on('close', () => { console.log('closed'); process.exit(0); });
