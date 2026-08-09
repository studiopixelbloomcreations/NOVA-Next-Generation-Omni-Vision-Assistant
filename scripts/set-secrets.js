// Write NOVA API keys into the OS-encrypted SecretStore vault.
// Run with the project's Electron binary (not plain node — safeStorage needs
// the Electron runtime). Writes into the same userData the packaged app uses.
//
// Usage:
//   electron scripts/set-secrets.js <GEMINI_API_KEY> <GROQ_API_KEY> [userDataDir]
// When userDataDir is omitted it uses the running app's default userData (the
// dev binary would write to a dev-only directory, so pass the installed app's
// userData explicitly when targeting the shipped build).
const { app } = require('electron');
const path = require('path');

// Load the compiled SecretStore from dist (main build output).
const { SecretStore } = require(path.join(__dirname, '..', 'dist', 'main', 'services', 'secret_store.js'));

const GEMINI_KEY = process.argv[2] || '';
const GROQ_KEY = process.argv[3] || '';
const TARGET_USER_DATA = process.argv[4] || '';

if (TARGET_USER_DATA) {
  app.setPath('userData', TARGET_USER_DATA);
}

app.whenReady().then(() => {
  try {
    const vault = path.join(app.getPath('userData'), 'secrets.vault');
    const store = new SecretStore(vault);
    if (GEMINI_KEY) store.set('GEMINI_API_KEY', GEMINI_KEY);
    if (GROQ_KEY) store.set('GROQ_API_KEY', GROQ_KEY);
    const list = store.list();
    console.log('VAULT_OK', JSON.stringify({ userData: app.getPath('userData'), keys: list }));
  } catch (err) {
    console.error('VAULT_ERR', err && err.message ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
