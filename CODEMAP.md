# Client code map

| Directory | Responsibility |
| --- | --- |
| `api/gen/es` | Generated protobuf-es bindings for the shared RPC and synchronization contracts; the protocol sources and their pipeline live outside this repository |
| `web/contracts` | Cross-boundary DTOs, settings and pure domain helpers |
| `web/frontend` | React/Cordis interface, browser adapters and canvas runtime integration |
| `web/backend` | Local host composition, routes and domain adapters |
| `web/services` | Canvas, task, media, application, MCP and local telemetry services |
| `web/extensions` / `extensions` | Public extension implementations and shared extension support |
| `web/vendor` | Maintained third-party sources and their notices |
| `web/tooling` / `web/e2e` / `web/showcase` | Cross-package tests, browser tests and component showcase |
| `bevy` | WASM/native renderer and recording tools |
| `desktop` | Tauri desktop shell and native host integration |
| `scripts` | Client development, build, packaging and verification |
| `locks` | Dependency lockfiles |

Start at `web/backend/src/composition.ts` for local host composition, `web/frontend/src/main.tsx` for the interface, and `bevy/src/lib.rs` for rendering. Extension discovery follows `extensions.config.json`. Generated API bindings enter this repository only as `api/gen/es` output: a protocol change arrives as a regenerated binding, never as a local edit.

Portable configuration handoff: `scripts/export-config.mjs` reads development configuration through `scripts/lib/development-config.mjs`; `scripts/lib/config-handoff.mjs` owns the separate configuration archive and merge/backup behavior. Tauri `desktop/src/local_host.rs` owns stop/import/restart and delegates `--import-config` to `scripts/desktop-host.mjs`. Application extension settings use the service's config-store API; imported model/deployment files belong to the user data directory.

Runtime model handoff reads the host public snapshot through `scripts/lib/runtime-models-export.mjs`. Imported metadata is displayed through `web/backend/src/host/core/runtime-model-catalog.ts`; it does not register generation providers. Desktop data owns `config/runtime-models.json`.

Windows dependency bootstrap: root `setup.ps1` checks the native toolchain before frozen client/web/api dependency installs; `-CheckOnly` performs only preflight checks. It does not build WASM or desktop installers.

Optional desktop runtimes: `web/runtime-components/` owns locked, signed component downloads, local CLI selection, installation receipts and leases. `web/backend/src/runtime-components/http.ts` exposes the loopback-only management API; the settings plugin provides explicit installation controls. `scripts/package-runtime-components.mjs` builds self-hosted CDN artifacts; `desktop/runtime-downloads.json` and `desktop/runtime-components.lock.json` define defaults and compatibility. Desktop recording watches verified component readiness; model rendering and Agent transports resolve components lazily. See `desktop/RUNTIMES.md`.

Canvas image editing prepares only after a direct edit request. `web/frontend/src/cordis/services/runtime-components.ts` shares host state and installation with settings; normal canvas viewing does not start it. Navigation owns feature entry guards; `photocraft/integrations/woohaa/src/editor-preparation.ts` merges repeated requests and isolates cancelled/stale completions, while `node-editor-readiness.tsx` shows an anchored loading/retry tip only for the requested node. Readiness resumes entry automatically; history viewing remains available. No automatic runtime alert is opened.
