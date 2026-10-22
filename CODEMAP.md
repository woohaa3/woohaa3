# Client code map

| Directory | Responsibility |
| --- | --- |
| `api/proto` / `api/gen` | Shared protocol definitions and generated Go/TypeScript bindings |
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

Start at `web/backend/src/composition.ts` for local host composition, `web/frontend/src/main.tsx` for the interface, and `bevy/src/lib.rs` for rendering. Extension discovery follows `extensions.config.json`. Generated API bindings are maintained only in `api/gen`; regenerate from `api/proto` rather than editing bindings.
