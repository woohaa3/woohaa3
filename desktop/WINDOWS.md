# Windows x64 standalone client

Build natively on Windows x64. Install Git, Node 24, pnpm 11.17.0, the pinned Rust MSVC toolchain, Visual Studio Build Tools with Desktop development with C++, and a Windows SDK. Install the WASM tools and LLVM listed in [the client setup](../README.md) as well. Use a short writable checkout path, and install dependencies on Windows rather than copying another platform's `node_modules`.

```powershell
pnpm install --frozen-lockfile
pnpm -C web install --frozen-lockfile
pnpm -C api install --frozen-lockfile
pnpm desktop:bundle --build-frontend
```

The complete current-user NSIS installer is written under `desktop/target/release/bundle/nsis/`. It bundles Node, the local host, extensions and native tools. Users do not need development tools or symbolic-link privileges. WebView2 installation may need network access; Tauri also downloads NSIS tools during builds. Authenticode signing requires the publisher's own certificate.

## Signed update channel

Keep the updater private key on the release machine, with its matching `.pub` file alongside it. Increase `desktop/tauri.conf.json`'s version before building an update. Set the update endpoint explicitly; the client has no default publisher CDN.

```powershell
$env:WOOHAA_DESKTOP_SIGNING_KEY = 'C:\private\woohaa\updater.key'
$env:WOOHAA_DESKTOP_UPDATE_ENDPOINT = 'https://updates.example.com/windows-x64/latest.json'
pnpm desktop:release --build-frontend
```

Upload the version directory from `artifacts/desktop/standalone-windows-x64/upload/` to the corresponding HTTPS directory, then upload `latest.json` last. The index uses platform key `windows-x86_64`; keep it separate from macOS. Permit anonymous reads of the index and version artifacts. Never upload the private signing key. The index includes the updater signature; installed clients validate with the matching embedded public key.

## Installation and lifecycle checks

Install in a separate directory and launch from the Start menu, then run the developer-side check with the actual executable path:

```powershell
pnpm desktop:host:check -- 'C:\path\to\installed\woohaa-desktop.exe'
```

Validate these behaviors on a Windows machine:

- Install and open as a normal user without system Node/pnpm; record SmartScreen, UAC and security-software prompts.
- Create a canvas, import media, save and reopen; verify renderer and recording behavior.
- Open a second instance and confirm it activates the existing window.
- Exit and confirm bundled Node and native helpers stop, with no data locks left behind.
- Export, import and restore a workspace, including paths with spaces and non-ASCII characters.
- Install a higher signed version through the configured update channel and confirm restart, version change and data retention.
- Confirm failed downloads can retry, while an unavailable update index permits the installed version to run.

Default data is under `%APPDATA%\com.woohaa.desktop`; host logs are in `logs\host.log` beneath the data directory. Use `WOOHAA_DESKTOP_DATA_DIR` for isolated checks. Workspace archives contain configuration and secrets and are unencrypted.

Windows installation and updater behavior require Windows verification; macOS build results do not validate this lifecycle. See the [desktop overview](README.md) for codec licensing and application boundaries.
