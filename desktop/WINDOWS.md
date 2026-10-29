# Windows x64 standalone client

Build natively on Windows x64. Install Git, Node 24, pnpm 11.17.0, the pinned Rust MSVC toolchain, Visual Studio Build Tools with Desktop development with C++, and a Windows SDK. Install the WASM tools and LLVM listed in [the client setup](../README.md) as well. Use a short writable checkout path, and install dependencies on Windows rather than copying another platform's `node_modules`.

```powershell
pnpm install --frozen-lockfile
pnpm -C web install --frozen-lockfile
pnpm -C api install --frozen-lockfile
pnpm desktop:bundle --build-frontend
```

The complete current-user NSIS installer is written under `desktop/target/release/bundle/nsis/`. It bundles Node, the local host, extensions and native tools. Users do not need development tools or symbolic-link privileges. WebView2 installation may need network access; Tauri also downloads NSIS tools during builds. Authenticode signing requires the publisher's own certificate.

## Continuous integration

[`.github/workflows/build-windows.yml`](../.github/workflows/build-windows.yml) builds the same unsigned installer on a GitHub-hosted Windows x64 runner (`windows-2022`). It runs on manual dispatch and on version tags; a tag such as `v0.1.2` supplies version `0.1.2`, and a manual run can override it.

```sh
gh workflow run build-windows.yml -f version=0.1.2
gh run download --name woohaa-desktop-windows-x64-<run-number>
```

The job pins Node 24.22.0, pnpm 11.17.0, Rust 1.97.1, wasm-bindgen 0.2.128 and Binaryen 133, then uploads the installer, the packaging manifest and the copied bundles as the `woohaa-desktop-windows-x64-<run-number>` artifact, kept for 14 days. It does not sign, notarize or publish: Authenticode and updater signing still require the publisher's own credentials, and the lifecycle checks below remain manual. A successful CI build alone does not establish installation, rendering or update behavior on Windows.

## Signed update channel

Keep the updater private key on the release machine, with its matching `.pub` file alongside it. Increase `desktop/tauri.conf.json`'s version before building an update. The client has no default publisher CDN: configure exactly one channel, a self-hosted HTTPS index or a GitHub Release.

```powershell
# Self-hosted HTTPS index
$env:WOOHAA_DESKTOP_SIGNING_KEY = 'C:\private\woohaa\updater.key'
$env:WOOHAA_DESKTOP_UPDATE_ENDPOINT = 'https://updates.example.com/windows-x64/latest.json'
pnpm desktop:release --build-frontend
```

```powershell
# GitHub Release
$env:WOOHAA_DESKTOP_SIGNING_KEY = 'C:\private\woohaa\updater.key'
$env:WOOHAA_DESKTOP_UPDATE_GITHUB_REPO = 'owner/name'
pnpm desktop:release --build-frontend
pnpm desktop:publish:github --repo owner/name --tag v0.1.7 --draft
```

For the CDN channel, upload the version directory from `artifacts/desktop/standalone-windows-x64/upload/` to the corresponding HTTPS directory, then upload `latest.json` last. The index uses platform key `windows-x86_64`; keep it separate from macOS. Permit anonymous reads of the index and version artifacts.

For GitHub Releases the build derives `https://github.com/<repo>/releases/latest/download/latest-windows-x86_64.json`, so each platform publishes its own index asset: a shared `latest.json` written by both platforms would overwrite the other platform's entry. `--draft` keeps the release invisible until you publish it, because `releases/latest` ignores drafts and prereleases. `WOOHAA_DESKTOP_UPDATE_GITHUB_RELEASE` pins a tag for a beta channel and `WOOHAA_DESKTOP_UPDATE_GITHUB_ASSET` overrides the asset name. Never upload the private signing key. The index includes the updater signature; installed clients validate with the matching embedded public key.

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

## Offline large-canvas experience kit

Build from a clean committed checkout so the installer and scenes have the same source revision. From the client root on Windows x64:

```powershell
git pull --ff-only
pnpm desktop:bundle --build-frontend --bundles nsis --release-id windows-large-canvas --out artifacts/desktop/windows-large-canvas --copy
node --experimental-strip-types scripts/canvas-benchmark/experience-kit.mjs artifacts/desktop/windows-large-canvas/manifest.json artifacts/desktop/windows-large-canvas/woohaa-windows-x64-experience.zip
```

The ZIP contains the unsigned NSIS `.exe`, `3000-text.woohaa-scene`, `3000-images.woohaa-scene`, `3000-models.woohaa-scene`, a Chinese guide and a SHA-256 manifest. Each scene has 3,000 nodes and 12,000 edges. The image scene embeds 400 unique 512×512 PNGs; the model scene embeds 400 self-contained scripts and retains the product's existing 16 preview-slot limit. The same ZIP is included in the Windows workflow artifact. No test data is committed to Git; the deterministic generator creates it during packaging.

Install and open the app, choose “导入场景文件” in the canvas switcher, then select one scene. Import creates a new local canvas. Its receipt-backed toolbar offers 200/300-node views, a distant bookmark, restoration into another new canvas, and “导出本机报告”. The original edited canvas is preserved. Scene originals are retained locally for restoration under a 2 GiB cache quota; imports fail safely if protected originals exhaust the quota. Remote-access hosts do not expose this local import API.

Reproduce a slowdown, then immediately export `woohaa-scene-report.json`: it contains the last 30 seconds of bounded frontend/runtime counters and optional feedback. It does not measure GPU presentation FPS. Export native diagnostics with “导出诊断日志…” as well; if the UI cannot respond, collect `%APPDATA%\com.woohaa.desktop\logs` (or the custom `WOOHAA_DESKTOP_DATA_DIR`). Include the scene/view, action, approximate time, whether resources had finished loading, and CPU/GPU/RAM/display refresh rate. Diagnostic logs can contain local paths or business content; inspect before sharing. Reports and logs are saved locally, without automatic upload by the scene experience feature.

Windows installation, offline import, GPU rendering, drag/zoom/navigation, report download, persistence and exit cleanup remain real-device acceptance checks. A successful build or macOS regression run is not a Windows performance result.
