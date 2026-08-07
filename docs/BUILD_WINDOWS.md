Windows native build instructions

Prerequisites (install before running electron rebuild):

- Visual Studio 2022 Build Tools (C++ workload) with Windows 10/11 SDK
  - https://visualstudio.microsoft.com/downloads/
- Rust toolchain (stable) with cargo
  - https://www.rust-lang.org/tools/install
- Node.js 18+ LTS

Steps:

1. Install the prerequisites above.
2. From the project root run:
   npm ci
   npm run rebuild-native
   npm run electron:start

Notes:
- The GitHub Actions workflow .github/workflows/windows-ci.yml attempts to run electron-rebuild on a windows-latest runner and will upload rebuild.log on failure for debugging.
- Known issue: isolated-vm often fails to link on Windows when Electron/V8 ABI mismatch occurs (unresolved v8 symbols). This requires either building isolated-vm against an Electron version that matches isolated-vm's expected V8 headers, or using a prebuilt binary for isolated-vm. See troubleshooting steps below.

Troubleshooting isolated-vm linking failures:
1. Ensure Visual Studio Build Tools with C++ workload and Windows SDK are installed.
2. Ensure the Rust toolchain is installed (some isolated-vm paths may require it).
3. Try running electron-rebuild with the same Electron version that will be used at runtime. Downgrading Electron to a version compatible with isolated-vm may help.
4. Search isolated-vm releases for prebuilt binaries matching your Electron version, or open an issue with isolated-vm maintainers.
5. As a last resort, keep isolated-vm excluded from rebuild and rely on the JS fallback while documenting the limitation.
