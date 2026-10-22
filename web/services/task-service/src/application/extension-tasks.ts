/** 插件非画布任务的进程内端口：共享 Task 校验、持久关联与完整结果读取。 */
import {
  checkModelCapability, containsWoohaa3CanvasMentionToken, decodeTaskSubmitRequest,
  type ApplicationExtensionTaskFacade
} from "@woohaa3/contracts";
import type { TaskExtensionTaskApiDependencies } from "../api/extension-task-api.js";

export function createExtensionTaskFacade(
  deps: TaskExtensionTaskApiDependencies, extensionId: string, configVersion: number
): ApplicationExtensionTaskFacade {
  const owns = (key: string) => deps.associations.find(key)?.extensionId === extensionId;
  return {
    async submit(input) {
      const existing = deps.associations.find(input.workerTaskKey);
      if (existing && existing.extensionId !== extensionId) return { ok: false, code: "unauthorized", message: "任务不属于该扩展" };
      const raw = input as unknown as Record<string, unknown>;
      if (["canvasId", "nodeId", "runId"].some(key => raw[key] !== undefined)) return { ok: false, code: "unsupported", message: "扩展不能提交画布节点任务" };
      const decoded = decodeTaskSubmitRequest({ ...input, canvasId: "plugin", nodeId: extensionId,
        runId: input.workerTaskKey, jobId: input.workerTaskKey,
        nodeType: input.modelType === "language" ? "text" : input.modelType === "video" ? "video" : input.modelType === "audio" ? "audio" : "image",
        inputs: input.inputs ?? [] });
      if (!decoded.ok) return { ok: false, code: "unsupported", message: "任务输入非法" };
      const catalog = await deps.resolveCatalog();
      if (!catalog.available) return { ok: false, code: "unavailable", message: "模型目录不可用" };
      const model = catalog.models.find(entry => entry.modelKey === input.modelKey && entry.modelType === input.modelType);
      if (!model || !checkModelCapability(decoded.value, model).ok || containsWoohaa3CanvasMentionToken(input.prompt)) {
        return { ok: false, code: "unsupported", message: "模型或输入能力不受支持" };
      }
      try {
        for (const resource of decoded.value.inputs) {
          if (!deps.mediaClient || !(await deps.mediaClient.verify(resource.storageKey)).exists) return { ok: false, code: "unavailable", message: "参考资源不可用" };
        }
        const outcome = await deps.submit(decoded.value, { extensionId, configVersion });
        if (outcome.conflict) return { ok: false, code: "key-reused", message: "相同任务标识使用了不同输入" };
        if (outcome.mediaError) return { ok: false, code: "unavailable", message: "参考资源不可用" };
        return { ok: true, workerTaskKey: input.workerTaskKey, reused: outcome.reused, state: outcome.state };
      } catch {
        return { ok: false, code: "storage-failed", message: "任务提交失败" };
      }
    },
    async status(workerTaskKey) {
      if (!owns(workerTaskKey)) return null;
      const detail = await deps.status(workerTaskKey);
      return detail ? { workerTaskKey, state: detail.state } : null;
    },
    async result(workerTaskKey) {
      if (!owns(workerTaskKey)) return null;
      const detail = deps.history.get(workerTaskKey, { fullText: true });
      return detail ? { workerTaskKey, state: detail.state, ...(detail.result ? { result: detail.result } : {}) } : null;
    },
    async cancel(workerTaskKey) {
      if (!owns(workerTaskKey)) return null;
      const state = await deps.cancel(workerTaskKey);
      return state === null ? null : { workerTaskKey, state };
    }
  };
}
