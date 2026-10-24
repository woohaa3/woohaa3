# Client code map

Shared composite children: `web/contracts/src/canvas/composite-children.ts` standardizes container/entity relationships, placement, grouped construction, owner movement and removal. `web/frontend/src/extension-api/composite-assets.ts` owns trusted child declarations, shared rect panels, ownership links and drag-along selection; `bevy/src/canvas_query/composite_panel.rs` and `bevy/src/canvas2d/scope_panel.rs` own geometry, text and thumbnail lifecycle. Film-set objects/shots and the eight-direction workflow use this API. Containers have no DOM overlay. Render Scene v25 is required; extension usage is documented in [COMPOSITE-CHILDREN.md](web/extensions/COMPOSITE-CHILDREN.md).

Film-set object containers: `web/contracts/src/canvas/film-set-object-container.ts` owns deterministic `(filmSetNodeId, itemId)` entrance identities; containers store ownership only. `film-set-object-replacement.ts` copies a model snapshot, preserves object identity/transform, adapts compatible motion bindings and disables incompatible scripts. The reducer creates containers for every object by default and reconciles owner movement, group and deletion; owner `filmSetObjectContainersHidden` persists explicit visibility choices; protected item-set edits restore snapshot and motion together. Sync protocol 6 protects these roles from older normalizers. `web/extensions/film-set/src/authoring/browser/object-containers.tsx` owns single-model drop and feedback; object-container-commands hydrates existing scenes on opening and saves per-object hide/show from the right-hand list through protected edits; its model adapter derives container geometry from the owner's current object. Clipboard remaps owner/item IDs together and double-click opens the owner film set.

Model resource registration: `bevy/src/bridge/assets.rs` retains the whole incoming registration batch until `queue_scene` accepts its references, then evicts idle resources. The 32-entry cache budget must never remove models from a not-yet-accepted first frame; mixed model/card scenes can legitimately exceed it.

Film-set static image references: `web/contracts/src/canvas/film-set-shot-image-reference.ts` owns image profiles, stable version identities and ready asset validation. Sync protocol 5 protects the independent image role; atomic clip conversion and protected undo/replay update consumer roles together. `web/extensions/film-set/src/authoring/browser/shot-image-reference.ts` owns bounded T=0/High capture, PNG registration, reuse/retry and download. Dynamic recording excludes static clips. The inspector owns object-first authoring and saved composition feedback; the shared camera panel takes an explicit capture policy.

`web/frontend/src/cordis/plugins/task-execution/submit-coordinator.ts` freezes image inputs and parameters at click time and resumes each waiting consumer once. The page shares this coordinator with ModelExecutionHost. `web/services/canvas-service/src/task/shot-reference-resolution.ts` validates frozen image metadata and builds an execution-only mapping; run-service revalidates before durable acceptance. `bevy/src/shot_node_preview` and shared `shot_camera` carry each rig's optional backdrop through preview and capture, waiting for real High/GPU readiness before readback.

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

Bevy WASM builds resolve one shared mode policy in `scripts/lib/bevy-build-mode.mjs`: development (incremental dev profile, no `wasm-opt`) is the default for `dev`, `dev:frontend`, `dev:desktop` and `build:bevy:dev`; `WOOHAA_BEVY_DEV_MODE=performance` or `build:bevy:perf` selects release compilation with `wasm-opt -Oz -g`; production `build`, `build:bevy` and desktop frontend assembly request release explicitly. `build-bevy-wasm.mjs` derives the target directory from `cargo metadata`, follows Cargo's own job defaults, serializes writers of the shared frontend output through a recoverable lock under `.local/locks/`, and only reuses post-processing when mode, inputs and the recorded JS/WASM/d.ts digests all match.
| `locks` | Dependency lockfiles |

Start at `web/backend/src/composition.ts` for local host composition, `web/frontend/src/main.tsx` for the interface, and `bevy/src/lib.rs` for rendering. Extension discovery follows `extensions.config.json`. Generated API bindings enter this repository only as `api/gen/es` output: a protocol change arrives as a regenerated binding, never as a local edit.

Canvas text raster resolution is shared by the browser WASM and the native canvas: `bevy/src/canvas2d/text_presentation.rs` owns the logical-size metadata, the bounded zoom steps and the glyph cap, and every 2D text producer (labels, edge labels, generation status, drag-attach bar, node action toolbar) only declares logical text. See the rendering map for the scheduling and invalidation rules.

Portable configuration handoff: `scripts/export-config.mjs` reads development configuration through `scripts/lib/development-config.mjs`; `scripts/lib/config-handoff.mjs` owns the separate configuration archive and merge/backup behavior. Tauri `desktop/src/local_host.rs` owns stop/import/restart and delegates `--import-config` to `scripts/desktop-host.mjs`. Application extension settings use the service's config-store API; imported model/deployment files belong to the user data directory.

Runtime model handoff reads the host public snapshot through `scripts/lib/runtime-models-export.mjs`. Imported metadata is displayed through `web/backend/src/host/core/runtime-model-catalog.ts`; it does not register generation providers. Desktop data owns `config/runtime-models.json`.

Windows dependency bootstrap: root `setup.ps1` checks the native toolchain before frozen client/web/api dependency installs; `-CheckOnly` performs only preflight checks. It does not build WASM or desktop installers.

Optional desktop runtimes: `web/runtime-components/` owns locked, signed component downloads, local CLI selection, installation receipts and leases. `web/backend/src/runtime-components/http.ts` exposes the loopback-only management API; the settings plugin provides explicit installation controls. `scripts/package-runtime-components.mjs` builds self-hosted CDN artifacts; `desktop/runtime-downloads.json` and `desktop/runtime-components.lock.json` define defaults and compatibility. Desktop recording watches verified component readiness; model rendering and Agent transports resolve components lazily. See `desktop/RUNTIMES.md`.

Canvas image editing prepares only after a direct edit request. `web/frontend/src/cordis/services/runtime-components.ts` shares host state and installation with settings; normal canvas viewing does not start it. Navigation owns feature entry guards; `photocraft/integrations/woohaa/src/editor-preparation.ts` merges repeated requests and isolates cancelled/stale completions, while `node-editor-readiness.tsx` shows an anchored loading/retry tip only for the requested node. Readiness resumes entry automatically; history viewing remains available. No automatic runtime alert is opened.

Local tool setup lives in `web/extensions/local-agent/src/frontend/settings-panel.tsx`: missing tools expose installation actions, including the shared runtime settings for Codex. `src/backend/runtime-executable.ts` bridges managed Codex and local executables; `process-manager.ts` holds the managed executable lease until process exit. Discovery stays read-only.

Assistant entry points share `web/frontend/src/cordis/ui/assistant-execution/model-selector.tsx` for selection and the empty-directory configuration action. `web/frontend/src/cordis/plugins/agent-assistant/setup-tooltip.tsx` supplies the corner toolbar's first-connection guidance through the optional `canvas.toolbar-action.tooltip` wrapper; it subscribes to the existing data-space-scoped directory and suppresses guidance during loading, errors, and dialogs.

`web/frontend/src/cordis/plugins/agent-assistant/first-use.ts` observes the same directory from the page plugin and opens the assistant dialog at `page: "add"` on the first successful empty result after canvas readiness. A data-space-scoped localStorage marker respects dismissal across reloads; failures, pending dialogs, scope changes and disposal do not create duplicate or stale prompts.

Runtime release layout: `scripts/lib/runtime-release-layout.mjs` owns platform/App-version directory and CDN URL resolution. `build-desktop.mjs` passes the effective App version into host staging; `package-runtime-components.mjs` writes the same platform/version upload directory and atomic signed catalog. Component/cache identities stay unchanged.

Shared runtime archives: `scripts/lib/runtime-archive.mjs` owns deterministic streaming USTAR/gzip generation. `web/runtime-components/index.mjs` accepts legacy schema 1 release-local archives and schema 2 SHA-256 blobs resolved under the runtime root; signed release catalogs remain platform/App-version scoped.

PhotoCraft editing: `photocraft/packages/editor/src/features/` owns the 18 feature domains. `features/tool-groups.ts` shares toolbar grouping and Shift cycling; `features/menu-commands.ts` derives runtime menu entries. `editor-sidebar.tsx` hosts independently dockable feature panels. Painting controls share gesture settings through `features/painting/controls-context.tsx`; canvas lasso/crop hooks use the workspace draft gate. Feature boundary fixtures live in `photocraft/tests/fixtures/feature-boundary-*.json`.

Composite asset node actions use the shared toolbar target contract. Rust toolbar drawing and interaction accept composite assets and anchor their actions to the scope AABB; viewport and position updates retain the same hit geometry. Film-set object rows expose their container action without requiring a selection.
