// Diagnostic: load the packaged renderer HTML in the packaged Electron and
// report did-fail-load / did-finish-load + renderer console messages.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const TARGET = process.argv[2] || process.env.NOVA_RENDERER_HTML;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (...args) => {
    const e = args[0];
    const level = e && e.level !== undefined ? e.level : args[1];
    const message = e && e.message !== undefined ? e.message : args[2];
    console.log(`RENDERER-CONSOLE[${level}] ${message}`);
  });
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.log(`DID-FAIL-LOAD code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    app.exit(2);
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`DID-FINISH-LOAD url=${win.webContents.getURL()}`);
    setTimeout(() => app.exit(0), 6000);
  });
  win.webContents.on('render-process-gone', (event, details) => {
    console.log(`RENDER-PROCESS-GONE reason=${details.reason} exitCode=${details.exitCode}`);
    app.exit(3);
  });
  console.log('TARGET:', TARGET);
  console.log('TARGET-EXISTS:', TARGET ? fs.existsSync(TARGET) : 'no target');
  if (TARGET) {
    win.loadFile(TARGET);
  }
});
