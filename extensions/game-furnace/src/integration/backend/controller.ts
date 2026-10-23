import { recoverGameProject } from "../../authoring/backend/recover-project.js";
/**
 * 游戏炼丹炉后端控制器（公共入口）
 * （change: 2026-10-10-add-game-furnace-extension，任务 6–8 / design D8–D13）。
 *
 * 经统一后端进程内 facade（owner-scoped Task/Media）完成：权威校验、输入编译、语言模型
 * 生成、结果校验、不可变构建保存与原子关联、本站只读预览会话。本模块不 import 宿主 store、
 * Provider 实现、数据库或凭据；只用公共 contracts 与自身 shared/codec。
 *
 * 按 integration 新架构重实现（关键差异，见 notes/port-plan.md 阶段 5）：扩展后端**没有任意
 * 画布读/写能力**（原实现用 `canvas.containers.snapshot/apply` + `decodeContainerEnvelope`）。
 * 项目 envelope 改为**内容寻址**：前端工作区把已确认的 `GameFurnaceState` + `inputHash` 交给
 * 本控制器（`openProject`），控制器用 Media 保存/读取不可变 envelope，并把稳定 `storageKey`
 * 写回项目当前值；节点只保存稳定的 `storageKey/inputHash/activeBuildId` 关联。素材字节读取
 * 改用 `media.resources.read(storageKey)`，不再有按 assetId 的 `resourceSession`。
 *
 * 领域用例在 authoring，快照存取在 state，试玩在 preview；这里仅装配控制器与生命周期。
 */
import { GAME_FURNACE_PLUGIN_ID } from "../../state/shared/index.js";
import { createGamePreviewHost, type GamePreviewHost } from "../../preview/backend/host.js";
import { projectKey, type GameFurnaceBackendServices, type GenerateRequest, type Runtime, type WorkFacade } from "../../state/backend/runtime.js";
import { runCollectResources } from "../../authoring/backend/collect.js";
import { runSaveProject } from "../../state/backend/projects.js";
import { runActivateBuild, runFinalize, runGeneration } from "../../authoring/backend/flows.js";
import { runOpenPreview } from "../../preview/backend/open.js";
import { createFinalizeWorker } from "../../authoring/backend/finalize-worker.js";
import { submitAgentGame } from "../../authoring/backend/agent-submit.js";
import { cancelGeneration, detachNode } from "../../authoring/backend/project-controls.js";
import { prepareGameProject } from "../../authoring/backend/project-workspace.js";
import path from "node:path";

export type { GameFurnaceBackendServices, GameFurnaceProjectSnapshot, GenerateRequest } from "../../state/backend/runtime.js";
export { compileInput } from "../../authoring/shared/input.js";

export type GameFurnaceController = {
  install(input: { services: GameFurnaceBackendServices; work: WorkFacade; settleWork?: Runtime["settleWork"]; preview?: GamePreviewHost; logger?: (event: Record<string, unknown>) => void; workspaceRoot?: string; finalizeIntervalMs?: number; deploymentBasePath?: string }): void;
  dispose(): void;
  /**
   * 登记/更新一个已确认项目：用 Media 保存不可变 envelope，返回稳定 storageKey。
   * 前端把返回的 storageKey 作为节点稳定关联保存（跨重启可 `openProject` 恢复）。
   */
  saveProject(input: { canvasId: string; nodeId: string; state: import("../../state/shared/index.js").GameFurnaceState }): Promise<Record<string, unknown>>;
  /** 按 storageKey 恢复项目；已完成 Task 的旧关联恢复会等待 worker 收尾并返回最新 envelope key。 */
  openProject(input: { canvasId: string; nodeId: string; projectStorageKey: string }): Promise<Record<string, unknown>>;
  /**
   * 从画布拖入收集素材：把前端规划的 `resources.add` 操作施加到当前项目并写入新的不可变
   * envelope，返回新 `storageKey`/`inputHash`。项目不存在时以确定性 projectId 自动初始化。
   */
  collectResources(input: { canvasId: string; nodeId: string; operations: readonly import("@woohaa3/contracts").Woohaa3CanvasJsonObject[]; expectedProjectStorageKey?: string }): Promise<Record<string, unknown>>;
  generate(input: GenerateRequest): Promise<Record<string, unknown>>;
  finalize(input: { canvasId: string; nodeId: string; generationId: string }): Promise<Record<string, unknown>>;
  submitGame(input: Parameters<typeof submitAgentGame>[1]): Promise<Record<string, unknown>>;
  prepareProject(input: { canvasId: string; nodeId: string; expectedInputHash: string }): Promise<Record<string, unknown>>;
  cancel(input: { canvasId: string; nodeId: string; generationId: string }): Promise<Record<string, unknown>>;
  /** 显式采用候选/历史构建为活动版本（任务 7.7；不新增生成或改动构建内容）。 */
  activateBuild(input: { canvasId: string; nodeId: string; buildId: string }): Promise<Record<string, unknown>>;
  /** 按当前授权项目与固定 buildId 创建短期只读预览会话并组装工作区预览。 */
  openPreview(input: { canvasId: string; nodeId: string; buildId: string }): Promise<Record<string, unknown>>;
  /** 直接打开预览入口：按 manifest 解析并返回带 CSP sandbox 的原始响应。 */
  previewFetch(sessionId: string, path: string): { contentType: string; bytes: Uint8Array; headers: Record<string, string> } | null;
  /** 工作区预览组装：入口 HTML + 授权资源（data URL，隔离沙箱内使用）。 */
  previewDescribe(sessionId: string): { html: string; assets: { path: string; dataUrl: string }[] } | null;
  /** 释放短期只读预览会话（任务 8.7：退出/切换版本/停止/作用域释放时回收资源）。 */
  previewClose(sessionId: string): void;
  /**
   * 目标删除时取消/脱离在该节点上的在途任务（任务 6.10）：按权限取消普通模型生成、释放工作
   * 准入，并删除内存项目快照（内容寻址 envelope 在 Media 保留，供旧构建只读检索）。
   * Agent 源码提交不对应站点 Task，仅脱离。返回被脱离的生成数。
   */
  detachTarget(input: { canvasId: string; nodeId: string }): Promise<{ ok: true; detached: number }>;
  /**
   * 立即处理一次所有在途生成（任务 6.9）。生产由后台 worker 自动轮询；本入口用于停用前
   * 主动 flush 与确定性测试，不要求浏览器在线。
   */
  flushFinalizations(): Promise<{ processed: number }>;
  runtime(): Runtime | null;
};

export function createGameFurnaceBackend(): GameFurnaceController {
  let runtime: Runtime | null = null;
  let worker: ReturnType<typeof createFinalizeWorker> | null = null;
  const withProject = (result: Record<string, unknown>, input: { canvasId: string; nodeId: string }) => {
    const project = runtime?.projects.get(projectKey(input.canvasId, input.nodeId));
    return result.ok === true && project ? { ...result, project } : result;
  };
  return {
    install(input) {
      worker?.stop();
      runtime = {
        workspaceRoot: input.workspaceRoot ?? path.resolve(process.cwd(), ".local/game-furnace-projects"),
        services: input.services,
        work: input.work,
        settleWork: input.settleWork,
        preview: input.preview ?? createGamePreviewHost(),
        deploymentBasePath: input.deploymentBasePath ?? "/",
        log: input.logger ?? (() => undefined),
        projects: new Map()
      };
      // 任务 6.9：自动后台收尾（提交响应丢失/无前端/重启恢复都无需浏览器轮询）。
      worker = createFinalizeWorker(runtime, { ...(input.finalizeIntervalMs !== undefined ? { intervalMs: input.finalizeIntervalMs } : {}) });
      worker.start();
    },
    dispose() {
      worker?.stop();
      worker = null;
      runtime?.preview.dispose();
      runtime = null;
    },
    async saveProject(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return runSaveProject(runtime, input);
    },
    async openProject(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return recoverGameProject(runtime, input, () => worker?.sweep());
    },
    async collectResources(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return runCollectResources(runtime, input);
    },
    async generate(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return withProject(await runGeneration(runtime, input), input);
    },
    async finalize(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return withProject(await runFinalize(runtime, input), input);
    },
    async submitGame(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return withProject(await submitAgentGame(runtime, input), input);
    },
    async prepareProject(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return prepareGameProject(runtime, input);
    },
    async cancel(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return withProject(await cancelGeneration(runtime, input), input);
    },
    async activateBuild(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return withProject(await runActivateBuild(runtime, input), input);
    },
    async openPreview(input) {
      if (!runtime) return { ok: false, code: "plugin-disabled", message: "游戏炼丹炉后端未装配" };
      return runOpenPreview(runtime, input);
    },
    previewFetch(sessionId, path) {
      if (!runtime) return null;
      return runtime.preview.resolve(sessionId, path) ?? null;
    },
    previewDescribe(sessionId) {
      if (!runtime) return null;
      return runtime.preview.describe(sessionId);
    },
    previewClose(sessionId) {
      runtime?.preview.revoke(sessionId);
    },
    async detachTarget(input) {
      if (!runtime) return { ok: true, detached: 0 };
      return detachNode(runtime, input);
    },
    async flushFinalizations() {
      if (!worker) return { processed: 0 };
      return worker.sweep();
    },
    runtime: () => runtime
  };
}

export { GAME_FURNACE_PLUGIN_ID, projectKey };
