/**
 * `woohaa3-ycanvas-v2` 共享契约（复合资产身份与 items-only 片场切换）。
 *
 * 这是本 change 的**格式与版本契约**，服务端 room、后端存储与浏览器 provider 都依赖它。
 * 放在这里而不是各处重复定义，是因为这些字符串/常量一旦漂移就会让「同一 canvas 的不同
 * 组件」对同一份文档产生不同解释。
 *
 * 四类版本语义各自单一职责（design D5），**不得混用**：
 * - `YJS_BUSINESS_REVISION`：成功且有净变化的命令批次版本 → meta.revision / REST ETag / frame payload
 * - `storageSeq`：数据库内 checkpoint/update 的严格恢复顺序，不暴露给前端业务
 * - Yjs state vector：浏览器与 published Y.Doc 的结构同步游标
 * - 渲染帧版本：单页面渲染通道的本地单调版本
 */

/** Y.Doc 内部格式版本；与 asset-canvas-v1（JSON 格式）独立演进。 */
export const YJS_CANVAS_FORMAT_VERSION = "woohaa3-ycanvas-v2" as const;
export type YjsCanvasFormatVersion = typeof YJS_CANVAS_FORMAT_VERSION;

/**
 * WebSocket 同步协议版本。单一事实源在 `../sync-protocol-version.js`（主入口可达），
 * 这里再导出以保持 `canvas-yjs` 子入口的既有消费路径。
 */
export { YJS_SYNC_PROTOCOL_VERSION, type YjsSyncProtocolVersion } from "../sync-protocol-version.js";

/**
 * room epoch：用于让旧连接/旧 cache 在握手时被识别为过期（客户端声明 epoch 与服务端不一致
 * 即必须丢弃本地 cache 重新同步），而不是靠消息 sequence 推断。
 */
export type CanvasRoomEpoch = string;

/** 生成一个新的 room epoch。调用方注入实现以便测试确定性。 */
export function createRoomEpoch(generate: () => string = () => crypto.randomUUID()): CanvasRoomEpoch {
  return generate();
}

/** 顶层 shared type 名（design D3）。固定常量，避免各处字符串字面量漂移。
 *
 * 不含 `viewport`：视口是各浏览器本地状态，不同步、不持久化。
 */
export const YJS_SHARED_TYPES = {
  meta: "meta",
  nodes: "nodes",
  edges: "edges",
  nodeData: "nodeData",
  assets: "assets",
  jobs: "jobs"
} as const;

export type YjsTopLevelKey = (typeof YJS_SHARED_TYPES)[keyof typeof YJS_SHARED_TYPES];

/** meta Y.Map 的固定字段。 */
export type YjsCanvasMeta = {
  formatVersion: YjsCanvasFormatVersion;
  id: string;
  title: string;
  documentSchemaVersion: string;
  /** 业务 revision（design D5）。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * 稳定排序：业务顺序**不得**依赖 `Y.Map` 迭代顺序（design D3）。
 *
 * 规则与 domain 的持久化语义一致：节点按 `zIndex` 升序、同值按 id 升序；
 * 边按 id 升序；资产/任务按 id 升序；nodeData 按 nodeId 升序。
 * 因此无论 Y.Map 内部如何排列，导出结果都确定。
 */
export function compareByZIndexThenId(
  left: { id: string; zIndex?: number },
  right: { id: string; zIndex?: number }
): number {
  const leftZ = typeof left.zIndex === "number" && Number.isFinite(left.zIndex) ? left.zIndex : 0;
  const rightZ = typeof right.zIndex === "number" && Number.isFinite(right.zIndex) ? right.zIndex : 0;
  if (leftZ !== rightZ) return leftZ - rightZ;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 按 id 升序比较，供边/资产/任务/nodeData key 排序使用。 */
export function compareById(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 按字符串 key 升序；用于 `Object.entries` 结果排序。 */
export function compareByKey([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
