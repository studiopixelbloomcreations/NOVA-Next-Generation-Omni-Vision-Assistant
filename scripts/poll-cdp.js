// Poll CDP for a page target; when found, dump title + body text.
// Usage: node scripts/poll-cdp.js <port> <seconds>
const http = require('http');
const WebSocket = require('ws');

const port = process.argv[2] || '9222';
const seconds = Number(process.argv[3] || 30);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

const deadline = Date.now() + seconds * 1000;

async function poll() {
  while (Date.now() < deadline) {
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
      const page = list.find(t => t.type === 'page');
      if (page) {
        console.log('PAGE FOUND:', JSON.stringify({ title: page.title, url: page.url }, null, 1));
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.on('open', () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: `JSON.stringify({ title: document.title, body: (document.body ? document.body.innerText.slice(0, 300) : 'NO BODY'), ready: document.readyState })`, returnByValue: true },
          }));
        });
        ws.on('message', m => {
          const msg = JSON.parse(m.toString());
          if (msg.id === 1) {
            console.log('PAGE STATE:', msg.result && msg.result.result && msg.result.result.value);
            process.exit(0);
          }
        });
        setTimeout(() => { console.log('(eval timeout)'); process.exit(1); }, 8000);
        return;
      }
      console.log('poll: no page target yet, targets=', list.length);
    } catch (e) {
      console.log('poll: endpoint not ready:', e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('NO PAGE TARGET within', seconds, 's');
  process.exit(1);
}
poll();
