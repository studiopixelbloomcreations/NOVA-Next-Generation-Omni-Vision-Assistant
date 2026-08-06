// smoke_headless.js - lightweight headless smoke test for Electron main modules
const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
  if (request === 'electron') {
    // Minimal stubbed electron APIs used by main modules
    return {
      app: {
        whenReady: async () => {},
        on: () => {},
        quit: () => {},
        isPackaged: false
      },
      BrowserWindow: class {
        constructor() { this.webContents = { send: ()=>{} }; }
        isDestroyed() { return false; }
        setIgnoreMouseEvents() {}
        minimize() {}
        maximize() {}
        unmaximize() {}
        close() {}
        loadFile() {}
        loadURL() {}
      },
      ipcMain: {
        on: ()=>{},
        handle: ()=>{}
      },
      screen: {
        getPrimaryDisplay: () => ({ size: { width: 800, height: 600 }, workAreaSize: { width: 800, height: 600 }, scaleFactor: 1 }),
      },
      desktopCapturer: {
        getSources: async () => []
      }
    };
  }
  return originalRequire.apply(this, arguments);
};

(async function main(){
  try {
    console.log('[smoke] Requiring dist/main/ingestors/screen_capturer');
    const scModule = require(path.join(__dirname, '..', 'dist', 'main', 'ingestors', 'screen_capturer'));
    const sc = scModule && scModule.screenCapturer ? scModule.screenCapturer : null;
    if (!sc) {
      console.error('[smoke] screenCapturer not exported from module');
      process.exit(2);
    }
    console.log('[smoke] screenCapturer loaded. Methods:',
      typeof sc.calculateBlockHashes === 'function' ? 'calculateBlockHashes() available' : 'no calculateBlockHashes',
      typeof sc.findMutatedBlocks === 'function' ? 'findMutatedBlocks() available' : 'no findMutatedBlocks'
    );

    // Synthetic buffer to exercise block-hash calculation
    const width = 256;
    const height = 128;
    const blockSize = 128;
    const bufLen = width * height * 4;
    console.log('[smoke] Creating synthetic buffer', { width, height, bufLen, blockSize });
    const buf = Buffer.alloc(bufLen);
    for (let i = 0; i < bufLen; i++) buf[i] = (i * 37) & 0xff;

    const hashes = sc.calculateBlockHashes(buf, width, height, blockSize);
    console.log('[smoke] calculateBlockHashes -> count:', hashes.length, 'sample:', hashes.slice(0, 8));

    const mutated = sc.findMutatedBlocks([], hashes);
    console.log('[smoke] findMutatedBlocks vs empty prev -> mutated count:', mutated.length, 'sample:', mutated.slice(0,8));

    console.log('[smoke] Smoke checks passed');
    process.exit(0);
  } catch (err) {
    console.error('[smoke] Error during smoke test:', err && err.stack ? err.stack : err);
    process.exit(3);
  }
})();
