import { isValidStorageKey, type ApplicationExtensionArchiveDefinition, type MediaStorage, type MediaStorageScope, type ServerCanvas } from "@woohaa3/contracts";
import { storageKeyChecksum } from "./asset-validation.js";
import type { ArchiveExtensionMediaReference } from "./archive-format.js";

/** 通用扩展引用收集；业务包只由可信清单装配，不由画布内容指定可执行入口。 */
export async function collectExtensionMediaReferences(
  canvas: ServerCanvas,
  definitions: readonly ApplicationExtensionArchiveDefinition[],
  storage?: MediaStorage,
  scope?: MediaStorageScope
): Promise<ArchiveExtensionMediaReference[]> {
  const references: ArchiveExtensionMediaReference[] = [];
  const registry = new Map<string, ApplicationExtensionArchiveDefinition>();
  for (const definition of definitions) {
    if (!definition.extensionId || registry.has(definition.extensionId)) throw Error("扩展归档清单 identity 非法或重复");
    registry.set(definition.extensionId, definition);
  }
  const read = async (key: string) => {
    if (!isValidStorageKey(key)) throw Error("扩展归档引用不是受控媒体键");
    if (!storage) throw Error("扩展归档需要媒体读取能力");
    const object = await storage.get(key, scope);
    if (object.bytes.byteLength > 16 * 1024 * 1024) throw Error("扩展归档结构对象超过读取上限");
    return object;
  };
  for (const node of canvas.document.nodes) {
    const nodeData = canvas.nodeData[node.id];
    const definition = typeof nodeData?.extensionId === "string" ? registry.get(nodeData.extensionId) : undefined;
    if (!definition || !nodeData) continue;
    const keys = [...new Set(await definition.collectMediaKeys({ nodeData, read }))].sort();
    if (keys.length > 65536) throw Error("扩展归档媒体引用超限");
    for (const storageKey of keys) {
      if (!isValidStorageKey(storageKey) || !storageKeyChecksum(storageKey)) throw Error("扩展归档引用不是受控媒体键");
      if (!storage) throw Error("扩展归档需要媒体读取能力");
      const metadata = storage.stat
        ? await storage.stat(storageKey, scope)
        : await read(storageKey).then(object => ({ size: object.bytes.byteLength, contentType: object.contentType }));
      references.push({ extensionId: definition.extensionId, nodeId: node.id, storageKey,
        checksum: storageKeyChecksum(storageKey)!, contentType: metadata.contentType ?? "application/octet-stream", size: metadata.size });
    }
  }
  return references;
}
