/**
 * 画布命令应用器（任务 2.2 / design D3）。
 *
 * **change: add-frontend-speculative-canvas-state（任务 1.2）**：纯 reducer 已下沉到
 * `@woohaa3/contracts` 的 browser-safe canvas domain，前后端共用同一份命令语义。本模块
 * 仅作为服务端 storage/core 的再导出与受限 API 面，不再自行实现 reducer。
 *
 * 引用完整性、原子批次、最小尺寸校验和规范化全部由 contracts 的
 * `applyCanvasCommands` 提供，因此 SQLite、Mongo、内存适配器与前端 speculative
 * projector 共用同一套领域语义。
 */
import {
  applyCanvasCommands as applySharedCanvasCommands,
  decodeCanvasCommandBatch,
  type CanvasCommandBatch
} from "@woohaa3/contracts";
import { CanvasStorageError } from "./errors.js";

export type {
  ApplyCanvasCommandsResult,
  CanvasCommandRejection,
  CanvasCommandRejectionCode
} from "@woohaa3/contracts";

/** 与 contracts 同签名的再导出（前端与服务端共用同一 reducer）。 */
export const applyCanvasCommands = applySharedCanvasCommands;

/** 已解码批次的类型收窄，供应用服务复用。 */
export function assertCanvasCommandBatch(input: unknown): CanvasCommandBatch {
  const decoded = decodeCanvasCommandBatch(input);
  if (!decoded.ok) {
    throw new CanvasStorageError("INVALID_COMMAND_BATCH", decoded.reason);
  }
  return decoded.batch;
}
