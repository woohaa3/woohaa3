/** 扩展清单只校验调用方注入的定义；生产由启动期目录扫描提供。 */
import type { ApplicationBackendExtensionDefinition } from "./contract.js";

export type ApplicationBackendExtensionManifest = {
  definitions: ApplicationBackendExtensionDefinition[];
};

/** 校验后端清单：extensionId 唯一且非空。 */
export function validateApplicationBackendExtensionManifest(
  definitions: readonly ApplicationBackendExtensionDefinition[]
): { ok: true } | { ok: false; message: string } {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (typeof definition.extensionId !== "string" || definition.extensionId === "") {
      return { ok: false, message: "后端插件 extensionId 必须是非空字符串" };
    }
    if (seen.has(definition.extensionId)) {
      return { ok: false, message: `后端清单含重复 extensionId：${definition.extensionId}` };
    }
    seen.add(definition.extensionId);
  }
  return { ok: true };
}

export function createApplicationBackendExtensionManifest(
  definitions: readonly ApplicationBackendExtensionDefinition[] = APPLICATION_BACKEND_EXTENSION_MANIFEST
): ApplicationBackendExtensionManifest {
  const validated = validateApplicationBackendExtensionManifest(definitions);
  if (!validated.ok) throw new Error(`Application 后端插件清单无效：${validated.message}`);
  return { definitions: [...definitions] };
}

/** 无目录宿主的嵌入式调用默认不装配业务扩展。 */
export const APPLICATION_BACKEND_EXTENSION_MANIFEST: readonly ApplicationBackendExtensionDefinition[] = [];
