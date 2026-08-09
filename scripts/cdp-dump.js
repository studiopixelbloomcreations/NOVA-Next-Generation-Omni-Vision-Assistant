// Diagnostic: connect to Electron's CDP endpoint and enumerate all targets.
// Usage: node scripts/cdp-dump.js [port]
const http = require('http');
const WebSocket = require('ws');

const port = process.argv[2] || '9222';

http.get(`http://127.0.0.1:${port}/json/version`, res => {
  let d = '';
  res.on('data', c => (d += c));
  res.on('end', () => {
    let version;
    try {
      version = JSON.parse(d);
    } catch {
      console.log('CDP version endpoint failed:', d.slice(0, 200));
      process.exit(1);
    }
    console.log('browser version:', version.Browser || version['Browser']);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      ws.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }));
    });
    ws.on('message', m => {
      const msg = JSON.parse(m.toString());
      if (msg.id === 1 && msg.result) {
        console.log('=== targets ===');
        for (const t of msg.result.targetInfos || []) {
          console.log(`${t.type} | ${t.title.slice(0, 60)} | ${t.url.slice(0, 120)}`);
        }
        if (!msg.result.targetInfos || msg.result.targetInfos.length === 0) {
          console.log('(no targets)');
        }
      }
    });
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 3000);
  });
});
