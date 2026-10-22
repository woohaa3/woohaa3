/**
 * published projection 只读适配器
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 1.2）。
 *
 * 把 `YjsDocumentRepository` 收窄成目录组合所需的 `CanvasPublishedReader`：只读取
 * published projection，不暴露 checkpoint/update/command 等 room 语义。
 */
import type { CanvasPublishedReader } from "../storage/core/index.js";
import type { YjsDocumentRepository } from "./yjs-repository.js";

export function createPublishedReader(repository: YjsDocumentRepository): CanvasPublishedReader {
  return {
    async loadPublished(canvasId) {
      const state = await repository.loadYjsState(canvasId);
      return state?.projection ?? null;
    }
  };
}
