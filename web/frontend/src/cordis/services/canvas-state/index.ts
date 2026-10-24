/**
 * `@woohaa3/frontend` 画布 state 公共入口（原 `@woohaa3/canvas-state` 并入）。
 *
 * Yjs 派生 facade、单一提交边界、Yjs cache 仓储与 IndexedDB 适配层。
 * Godot 桥接（frame channel / projection / coordinator / boot）已随
 * `replace-godot-canvas-runtime-with-bevy` 删除。
 */
export * from "./repository/indexeddb-yjs-cache-repository.js";
export * from "./store/canvas-commit.js";
export * from "./store/yjs-facade.js";
export * from "./store/canvas-store.js";
export * from "./store/working-projection.js";
export * from "./store/canonical-projection-cache.js";
export * from "./store/edit-journal.js";
export * from "./store/canvas-edit-service.js";
export * from "./sync-status.js";
export * from "./indexeddb/canvas-db.js";
export * from "./indexeddb/yjs-cache.js";
