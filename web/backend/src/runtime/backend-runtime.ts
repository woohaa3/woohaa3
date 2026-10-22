/**
 * 站点插件宿主上的后端插件激活。
 *
 * 外部画布迁移这类不在站点目录里的可信后端插件，仍按 `ApplicationBackendExtensionDefinition`
 * 在 Application 拥有的唯一插件宿主上激活（宿主提供依赖解析、owner-scoped disposer、反序回滚与
 * 停用 draining）。Provider 不走这里，它们是插件树扩展层的 Cordis 插件。
 */
import type { ApplicationBackendExtensionDefinition } from "@woohaa3/contracts";
import type { ApplicationExtensionHost } from "@woohaa3/application-service";
import type { GenerationExtension } from "../extensions/contract.js";

export type BackendRuntimeOptions = {
  /** 构建时可信后端插件清单（`web/extensions/<id>/backend` 静态导入）。 */
  definitions: readonly ApplicationBackendExtensionDefinition[];
  generation: GenerationExtension;
  host: ApplicationExtensionHost;
  logger?: (event: Record<string, unknown>) => void;
};

export type BackendRuntime = {
  generation: GenerationExtension;
  host: ApplicationExtensionHost;
  /** 该插件是否由本 runtime 激活。 */
  owns: (extensionId: string) => boolean;
  /** 按清单激活全部插件（optional 失败隔离）。 */
  activate: () => Promise<Array<{ extensionId: string; ok: boolean; message?: string }>>;
  /** 失效并重激活某 extensionId 的全部定义（凭据变更后调用）。 */
  reactivate: (extensionId: string) => Promise<void>;
};

export function createBackendRuntime(options: BackendRuntimeOptions): BackendRuntime {
  const log = options.logger ?? (() => undefined);
  const { host } = options;

  const activate = async (): Promise<Array<{ extensionId: string; ok: boolean; message?: string }>> => {
    const results: Array<{ extensionId: string; ok: boolean; message?: string }> = [];
    for (const definition of options.definitions) {
      const result = await host.activate(definition);
      if (result.ok) {
        results.push({ extensionId: definition.extensionId, ok: true });
      } else {
        log({ event: "backend-plugin-activation-failed", extensionId: definition.extensionId, code: result.code, message: result.message });
        results.push({ extensionId: definition.extensionId, ok: false, message: result.message });
      }
    }
    return results;
  };

  return {
    generation: options.generation,
    host,
    owns: (extensionId) => options.definitions.some((definition) => definition.extensionId === extensionId),
    activate,
    reactivate: async (extensionId) => {
      await host.disposeExtension(extensionId);
      for (const definition of options.definitions) {
        if (definition.extensionId !== extensionId) continue;
        const result = await host.activate(definition);
        if (!result.ok) {
          log({ event: "backend-plugin-reactivation-failed", extensionId, code: result.code, message: result.message });
        }
      }
    }
  };
}
