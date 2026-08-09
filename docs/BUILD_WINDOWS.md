# NOVA Genesis — Windows Build & Packaging

NOVA Genesis is an **Electron-only** desktop application. There is no browser
dev server, no localhost listener, and no web dashboard. The renderer is
bundled at build time and loaded from disk.

## Prerequisites

Install before running the native rebuild:

- **Visual Studio 2022 Build Tools** (C++ workload) with Windows 10/11 SDK
  https://visualstudio.microsoft.com/downloads/
- **Rust toolchain (stable)** with cargo — required for the native
  screen-capture crate
  https://www.rust-lang.org/tools/install
- **Node.js 18+ LTS**
- **Python 3** (optional — only needed for local speaker diarization tooling)

## Quick start

```bash
npm ci                  # installs dependencies and rebuilds native modules
npm run dev:dual        # compile + launch Electron (no dev server)
```

## Python backend (optional but recommended)

The Python worker (`python/nova_runtime`) is stdlib-only and starts automatically
when `python` is on PATH. For OCR and desktop automation, install the optional
extras into the bundled venv:

```bash
cd python
python bootstrap.py          # creates .nova-venv, installs pillow/pytesseract/pyautogui
python bootstrap.py --status # confirm availability
```

- Point the app at a specific interpreter with `NOVA_PYTHON_PATH`.
- Restrict the filesystem service with `NOVA_PYTHON_ROOTS` (;-separated).
- In packaged installs, set `NOVA_PYTHON_PACKAGE` to a checkout of this `python/`
  directory, or rely on `NOVA_PYTHON_PATH` pointing at an environment that has it.

The worker never receives API keys — every spawn uses a scrubbed environment.

## Verification

```bash
npm run typecheck       # TypeScript: main + renderer
npm run build           # compile main process + bundle renderer
npm run test:unit       # 34 headless unit tests (no Electron required)
npm run e2e:smoke       # end-to-end tool synthesis smoke test
npx eslint src scripts  # lint
```

> `npm run test:unit` runs under plain Node. The tool store automatically falls
> back to JSON persistence because `better-sqlite3` is rebuilt for Electron's
> ABI; the sandbox executor still exercises real isolated-vm compilation.

## Packaging

```bash
npm run electron:package
```

Produces, in `dist_electron/`:

- **Nova Genesis Setup x.x.x.exe** — NSIS installer (install directory
  selection, desktop + start-menu shortcuts)
- **Nova Genesis x.x.x.exe** — portable single-file executable

Configuration lives in the `build` section of `package.json`:

```json
"build": {
  "appId": "com.nova.genesis",
  "productName": "Nova Genesis",
  "asar": false,
  "directories": { "output": "dist_electron", "buildResources": "build" },
  "files": ["dist/**/*", "native_modules/**/*", "package.json"],
  "extraResources": [{ "from": "native_modules/", "to": "native_modules" }],
  "win": { "target": [ { "target": "nsis", "arch": ["x64"] },
                       { "target": "portable", "arch": ["x64"] } ] },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true },
  "npmRebuild": true
}
```

**Icon:** drop `build/icon.ico` to give the installer/portable builds a branded
icon (electron-builder picks it up automatically). Without it, the default
Electron icon is used.

## Native module rebuild

```bash
npm run rebuild-native          # all native deps incl. isolated-vm
npm run rebuild-native-partial  # better-sqlite3, porcupine, vad, onnxruntime
```

The `postinstall` hook runs the partial rebuild so `npm ci` is non-blocking
even when `isolated-vm` cannot link.

## Known issue — isolated-vm on Windows

`isolated-vm` frequently fails to link against Electron's V8 headers on
Windows (unresolved V8 symbols), so it is excluded from the partial rebuild.

- If `isolated-vm` builds for your Electron ABI, the sandbox executor uses it
  (memory cap + timeout + caching).
- If it is unavailable, the executor reports the failure per tool and the
  validator emits a `SANDBOX_UNAVAILABLE` warning. Static validation still runs.

Troubleshooting the link failure:

1. Ensure VS Build Tools (C++ workload) and the Windows SDK are installed.
2. Try `npm run rebuild-native` with the exact Electron version in use.
3. Prefer an `isolated-vm` prebuilt binary matching your Electron version.
4. Keep `isolated-vm` excluded from the rebuild and rely on builtin tools while
   documenting the limitation (the supported path in CI today).

## CI

`.github/workflows/windows-ci.yml` (windows-latest):

1. `npm ci`
2. `npm run rebuild-native` (log uploaded on failure)
3. `npm run build`
4. `npm run test:unit`
5. `npm run e2e:smoke`
6. `npm run electron:package` (artifacts uploaded)
