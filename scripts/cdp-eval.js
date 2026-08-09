// Diagnostic: evaluate an expression in a CDP/Node-inspector target.
// Usage: node scripts/cdp-eval.js <port> "<expression>"
const http = require('http');
const WebSocket = require('ws');

const port = process.argv[2];
const expression = process.argv[3] || '1+1';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const list = await get(`http://127.0.0.1:${port}/json/list`);
  let targets;
  try {
    targets = JSON.parse(list);
  } catch {
    console.log('no targets on', port, '->', list.slice(0, 200));
    process.exit(1);
  }
  const target = targets.find(t => t.webSocketDebuggerUrl) || targets[0];
  if (!target) {
    console.log('no debugger target');
    process.exit(1);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.on('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.on('message', m => {
    const msg = JSON.parse(m.toString());
    if (msg.id === 1) {
      const res = msg.result && msg.result.result;
      if (res && res.exceptionDetails) {
        console.log('EXCEPTION:', res.exceptionDetails.text, res.exceptionDetails.exception && res.exceptionDetails.exception.description);
      } else {
        console.log(JSON.stringify(res && res.value, null, 1));
      }
      ws.close();
      process.exit(0);
    }
  });
  setTimeout(() => { console.log('(timeout)'); process.exit(1); }, 10000);
})();
