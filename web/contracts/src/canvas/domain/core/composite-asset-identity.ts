/**
 * 复合资产节点共同类别与业务身份
 * （change: 2026-10-11-extract-film-set-extension，D1/D11/D12；
 *  change: 2026-10-28-generic-extension-content-ownership，任务 1.1）。
 *
 * 「复合资产节点」管理由原始素材组成的复合资产。共享**唯一** canonical type
 * `composite-asset`，以 nodeData.extensionId 表达业务身份。
 *
 * 权威规则：
 * - 内核不认识任何具体扩展 id，也没有白名单；`extensionId` 只做**语法**校验；
 * - 身份是否可信由当前 scope 已激活并注册的 owner 决定（见 `content-contribution.ts`）；
 * - 未注册 owner 的数据保留并允许只读呈现，但任何业务写入在副作用前被拒绝；
 * - 片场已迁到 group marker；旧 `composite-asset` 片场只作为离线迁移读取输入。
 */
export const COMPOSITE_ASSET_NODE_TYPE = "composite-asset" as const;

/** 稳定的扩展 id 语法（与 extension.json 的 extensionId 规则一致）。 */
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const MAX_EXTENSION_ID_LENGTH = 200;

/** 是否复合资产节点类别（不看业务）。 */
export function isCompositeAssetNodeType(type: string | undefined): boolean {
  return type === COMPOSITE_ASSET_NODE_TYPE;
}

/**
 * 读取复合资产的业务标识；缺失或语法非法返回 `null`。
 *
 * 这里**只**做语法校验：是否受信任由注册表决定，内核不按 id 猜测业务。
 */
export function readCompositeAssetExtensionId(nodeData: unknown): string | null {
  if (typeof nodeData !== "object" || nodeData === null) return null;
  const id = (nodeData as { extensionId?: unknown }).extensionId;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_EXTENSION_ID_LENGTH && EXTENSION_ID.test(id)
    ? id
    : null;
}
