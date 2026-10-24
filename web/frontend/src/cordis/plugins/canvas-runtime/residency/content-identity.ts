/**
 * 节点的稳定内容身份
 * （change: 2026-10-23-scale-canvas-media-residency，design D4）。
 *
 * 内容身份 = 资产/模型内容本身，**不含** nodeId、展示 URL 前缀或画布读提示。这里只读取规范
 * 数据（`nodeData.outputAssetId` → 资产 storageKey；模型 prepared resource 的 resourceKey），
 * 不解析媒体 URL、不创建资源。
 *
 * 性能口径（design D7 / 任务 7.1）：资产表按画布对象身份 memo，静止帧不重建索引；身份解析
 * 只做 map 查找，不逐节点线性搜索资产数组。
 */
import { isCompositeAssetNodeType } from "@woohaa3/contracts";
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";

/** 画布节点（渲染中立）：只依赖身份、类型与位置，不读取 `data`。 */
type CanvasNode = ServerCanvas["document"]["nodes"][number];

/** 资产的内容身份：storageKey 优先（内容寻址），其次 checksum，最后受控 url。 */
export function assetContentKey(asset: StoredAsset | undefined): string | null {
  if (!asset || asset.status !== "ready") return null;
  const storageKey = (asset.metadata as { storageKey?: unknown } | undefined)?.storageKey;
  if (typeof storageKey === "string" && storageKey) return `asset:${storageKey}`;
  const checksum = (asset.metadata as { checksum?: unknown } | undefined)?.checksum;
  if (typeof checksum === "string" && checksum) return `asset:sha256-${checksum}`;
  // 最后回退到去掉查询串的受控 url（授权提示不进入内容身份）。
  return asset.url ? `asset-url:${asset.url.split("?")[0]}` : null;
}

export type ContentIdentityOptions = {
  /** 模型 prepared resource key（nodeId → resourceKey）；缺省视为无模型内容。 */
  modelResourceKey?: (nodeId: string) => string | null;
  /** 复合资产内容身份；缺省用「画布 + 节点」稳定身份。 */
  compositeKey?: (node: CanvasNode, canvas: ServerCanvas) => string | null;
};

/** 节点 → 当前可驻留内容身份（`null` 表示没有合法内容）。 */
export type ContentKeyOf = (node: CanvasNode) => string | null;

/**
 * 构造按画布对象身份 memo 的 `ContentKeyOf`。
 *
 * 返回的函数在 working 画布对象不变时复用同一份资产索引；结构变化会替换 working 对象，
 * 索引随之重建（与 `sharedCanvasNodeIndex` 同一口径）。
 */
export function createContentIdentity(
  options: ContentIdentityOptions = {}
): (canvas: ServerCanvas | null) => ContentKeyOf {
  let memoSource: ServerCanvas | null = null;
  let memoAssets = new Map<string, StoredAsset>();
  const assetsOf = (canvas: ServerCanvas): Map<string, StoredAsset> => {
    if (canvas === memoSource) return memoAssets;
    memoSource = canvas;
    memoAssets = new Map(canvas.assets.map((asset) => [asset.id, asset]));
    return memoAssets;
  };
  return (canvas) => (node) => {
    if (!canvas) return null;
    if (node.type === "image" || node.type === "video") {
      const outputId = (canvas.nodeData as Record<string, { outputAssetId?: unknown } | undefined>)[node.id]
        ?.outputAssetId;
      if (typeof outputId !== "string") return null;
      return assetContentKey(assetsOf(canvas).get(outputId));
    }
    if (node.type === "model3d") return options.modelResourceKey?.(node.id) ?? null;
    if (isCompositeAssetNodeType(node.type)) {
      // 复合资产若已派生 prepared model resource（片场/游戏炼丹炉的模型投影），内容身份必须是
      // 该资源的 `resourceKey`：只有模型 key 才会被 `setModelPayloadLeases` 认作 payload lease。
      // 用合成身份会让片场的模型 payload 永远进不了需求集合，被 Rust 侧淘汰后不再重建，
      // 表现为「片场节点的模型全部不显示」。非模型复合资产（如生物视频资产）没有 prepared
      // 资源，才回落到合成身份。
      const modelKey = options.modelResourceKey?.(node.id);
      if (modelKey) return modelKey;
      return options.compositeKey?.(node, canvas) ?? `${canvas.id}:composite:${node.id}`;
    }
    return null;
  };
}
