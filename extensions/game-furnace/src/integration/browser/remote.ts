/**
 * 游戏炼丹炉后端 handler 客户端
 * （change: 2026-10-10-add-game-furnace-extension，任务 5.x/6.x；按 integration 新架构重实现）。
 *
 * 工作区经宿主注入的通用 `applicationRemote.transport` 调用本扩展**自有**服务端 handler
 * （`/api/extensions/game-furnace/handlers/<route>`）；浏览器不持有服务间令牌，也不自建 fetch。
 * 只解释本扩展的业务协议，失败映射为稳定结果（不泄漏底层正文）。
 */
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import { GAME_FURNACE_PLUGIN_ID, validateGameFurnaceState, type GameFurnaceState } from "../../state/shared/index.js";
import type { GameFurnaceRemote } from "../../state/browser/remote-port.js";

/** handler 公共前缀（受控 owner-scoped 分派）。 */
export function handlerPath(route: string): string {
  return `/api/extensions/${GAME_FURNACE_PLUGIN_ID}/handlers/${route}`;
}

export const GAME_FURNACE_ROUTES = {
  projectSave: "game-furnace/project-save",
  projectOpen: "game-furnace/project-open",
  projectCollect: "game-furnace/project-collect",
  generate: "game-furnace/generate",
  finalize: "game-furnace/finalize",
  cancel: "game-furnace/cancel",
  activateBuild: "game-furnace/activate-build",
  previewOpen: "game-furnace/preview-open",
  previewDescribe: "game-furnace/preview-describe",
  previewClose: "game-furnace/preview-close",
  targetDetach: "game-furnace/target-detach"
} as const;

export type { GameFurnaceRemote, GameFurnaceRemoteResult } from "../../state/browser/remote-port.js";
export { remoteFailureMessage } from "../../state/browser/remote-port.js";
export type GameFurnaceRemoteOptions = {
  transport: ApplicationRemoteTransport;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  return record && typeof record.message === "string" && record.message !== "" ? record.message : fallback;
}

/**
 * 构造远端客户端。`openProject` 额外校验响应携带合法 `state` 对象，避免把畸形正文当作项目。
 */
export function createGameFurnaceRemote(options: GameFurnaceRemoteOptions): GameFurnaceRemote {
  const post = async (route: string, body: unknown) => {
    try { return await options.transport.request({ path: handlerPath(route), method: "POST", body }); }
    catch { return { ok: false as const, code: "unavailable", error: "服务暂时不可用" }; }
  };

  return {
    async saveProject(input) {
      const result = await post(GAME_FURNACE_ROUTES.projectSave, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data) ?? {};
      if (data.ok !== true || typeof data.projectStorageKey !== "string" || typeof data.inputHash !== "string") {
        return { ok: false, code: "malformed-response", message: "保存响应无法识别" };
      }
      if (data.state !== undefined) {
        try { validateGameFurnaceState(data.state as GameFurnaceState); }
        catch { return { ok: false, code: "malformed-response", message: "保存的项目状态无法识别" }; }
      }
      return { ok: true, value: { projectStorageKey: data.projectStorageKey, inputHash: data.inputHash,
        ...(data.state !== undefined ? { state: data.state as GameFurnaceState } : {}) } };
    },
    async openProject(input) {
      const result = await post(GAME_FURNACE_ROUTES.projectOpen, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data) ?? {};
      const state = asRecord(data.state);
      if (data.ok !== true || typeof data.projectStorageKey !== "string" || !state) {
        return { ok: false, code: "malformed-response", message: "项目响应无法识别" };
      }
      try { validateGameFurnaceState(state as unknown as GameFurnaceState); }
      catch { return { ok: false, code: "malformed-response", message: "项目版本或状态无法识别" }; }
      return {
        ok: true,
        value: {
          projectStorageKey: data.projectStorageKey,
          inputHash: typeof data.inputHash === "string" ? data.inputHash : "",
          state: state as unknown as GameFurnaceState
        }
      };
    },
    async collectResources(input) {
      const result = await post(GAME_FURNACE_ROUTES.projectCollect, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data) ?? {};
      if (data.ok !== true || typeof data.projectStorageKey !== "string" || typeof data.inputHash !== "string") {
        return { ok: false, code: "malformed-response", message: "收集响应无法识别" };
      }
      return { ok: true, value: { projectStorageKey: data.projectStorageKey, inputHash: data.inputHash } };
    },
    async generate(input) {
      const result = await post(GAME_FURNACE_ROUTES.generate, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "生成失败" };
      return { ok: true, value: data };
    },
    async finalize(input) {
      const result = await post(GAME_FURNACE_ROUTES.finalize, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "收尾失败" };
      return { ok: true, value: data };
    },
    async previewOpen(input) {
      const result = await post(GAME_FURNACE_ROUTES.previewOpen, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "预览失败" };
      return { ok: true, value: data };
    },
    async cancel(input) {
      const result = await post(GAME_FURNACE_ROUTES.cancel, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "取消失败" };
      return { ok: true, value: data };
    },
    async activateBuild(input) {
      const result = await post(GAME_FURNACE_ROUTES.activateBuild, input);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      const data = asRecord(result.data);
      if (!data || data.ok !== true || typeof data.activeBuildId !== "string") {
        return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "采用版本失败" };
      }
      return { ok: true, value: data };
    },
    async previewDescribe(input) {
      const result = await post(GAME_FURNACE_ROUTES.previewDescribe, input);
      if (!result.ok) return { ok: false, code: result.code, message: readMessage(result, "预览会话无效") };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "预览组装失败" };
      return { ok: true, value: data };
    },
    async previewClose(input) {
      const result = await post(GAME_FURNACE_ROUTES.previewClose, input);
      if (!result.ok) return { ok: false, code: result.code, message: readMessage(result, "预览会话释放失败") };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "预览会话释放失败" };
      return { ok: true, value: data };
    },
    async detachTarget(input) {
      const result = await post(GAME_FURNACE_ROUTES.targetDetach, input);
      if (!result.ok) return { ok: false, code: result.code, message: readMessage(result, "删除目标处理失败") };
      const data = asRecord(result.data);
      if (!data || data.ok !== true) return { ok: false, code: typeof data?.code === "string" ? data.code : "malformed-response", message: "删除目标处理失败" };
      return { ok: true, value: data };
    }
  };
}

/** 读取失败的安全消息（供 UI 展示，绝不回显可能含内部信息的底层正文）。 */
