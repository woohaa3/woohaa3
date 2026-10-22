import { type GameFurnaceState } from "../shared/index.js";
import type { GamePreviewHost } from "./preview-port.js";
import type { SupportedModelInput } from "../shared/model-input.js";

export type GameFurnaceProjectSnapshot = {
  /** 已保存的 envelope 内容寻址键（节点保存它以跨重启恢复）。 */
  projectStorageKey: string;
  /** Only automatic finalization may supersede these stale node associations. Not persisted. */
  recoveredFromStorageKeys?: readonly string[];
  state: GameFurnaceState;
  /** 已确认输入 hash（`computeInputHash(state)` 的稳定副本）。 */
  inputHash: string;
  /** 归属画布/节点（任务 6.9/6.10：后台收尾与目标脱离按身份寻址，不解析 map key）。 */
  canvasId: string;
  nodeId: string;
};

export type GenerateRequest = {
  canvasId: string;
  nodeId: string;
  /** 浏览器确保本次运行采用的已确认输入 hash；服务端重算比对，不信任其内容。 */
  expectedInputHash: string;
  /**
   * 前端依据当前 catalog 派生的模型参考输入能力（任务 6.6）。缺省（未提供）表示保守地不提交
   * 任何多模态参考输入——只保留资源描述/运行时清单，不强行提交不受支持的 binding。
   */
  supportedInputs?: readonly SupportedModelInput[];
};

/**
 * 控制器可用的最小服务集合（由后端插件从 host facade 适配）。
 *
 * 这里刻意用结构化最小面而非完整 `ApplicationExtensionServices`，使确定性测试可注入替身，
 * 也避免控制器耦合宿主 facade 的具体类型。
 */
export type GameFurnaceBackendServices = {
  tasks: import("@woohaa3/contracts").ApplicationExtensionTaskFacade;
  media: import("@woohaa3/contracts").ApplicationExtensionMediaFacade;
};

export type WorkFacade = () => { ok: true; workId: string; configVersion: number } | { ok: false; reason: string };

export type Runtime = {
  workspaceRoot: string;
  services: GameFurnaceBackendServices;
  work: WorkFacade;
  settleWork?: (workId: string, state: "succeeded" | "failed" | "cancelled") => void;
  preview: GamePreviewHost;
  /** 当前公开挂载路径（入口 URL 派生用；change: 2026-10-15-...）。 */
  deploymentBasePath: string;
  log: (event: Record<string, unknown>) => void;
  /** owner scope：canvasId:nodeId → 最近一次已确认/已保存的项目快照。 */
  projects: Map<string, GameFurnaceProjectSnapshot>;
};

export function projectKey(canvasId: string, nodeId: string): string {
  return `${canvasId}:${nodeId}`;
}
