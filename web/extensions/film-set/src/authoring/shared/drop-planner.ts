/**
 * 片场复制拖入（change: 2026-10-08-make-film-set-model-only，任务 2.3/3.3 / design D4；
 * change: 2026-10-18-restrict-film-set-drop-to-models：片场只接收普通模型，图片/视频不再拖入）。
 *
 * 这是共享拖动族在 pointerup 阶段的**片场 drop 分派**：当拖动源节点落在 `composite-asset`
 * 范围内时，优先尝试复制导入，而不是提交源节点移动。来源位置**从不**进入导入命令；导入
 * 接受、失败、拒绝或取消后源节点都回到原位（拖动 preview 被清理，不提交 `node.update`）。
 *
 * 由拖动族委托调用；渲染与命中复用 contracts 的同一投影逻辑。
 */
import { createHighEntropyId, scriptModel3DNodeData, isFilmSetGroupNode, modelSourceHash, planFilmSetImportItems, readFilmSetAnimationProjection, readFilmSetGroupMarker, createFilmSetGroupMarker, contentKeyForFilmSetGroupSource, type FilmSetGroupMarker, type CanvasCommand, type FilmSetImportItemDraft, type ServerCanvas, type Woohaa3CanvasSerializedNode } from "@woohaa3/contracts";

/**
 * 片场拖入可接受的来源节点类型：**只有普通模型**。
 *
 * 图片/视频已不再支持拖入片场（它们不再显示片场提示，释放时明确拒绝并让来源回位）；
 * 片场里既有的图片/视频对象仍正常显示、播放与编辑。
 */
const IMPORTABLE_SOURCE_TYPES = new Set(["model3d"]);

/** 来源不被接收时对用户说明的原因（拖动提示与释放反馈共用同一句）。 */
export const FILM_SET_DROP_UNSUPPORTED_SOURCE = "仅普通模型可以拖入片场";

export type FilmSetDropTarget = {
  canvasId: string;
  nodeId: string;
  sources: FilmSetDropSource[];
};

export type FilmSetDropSource = {
  kind: "model";
  itemId: string;
  name: string;
  sourceNodeId: string;
  /** 来源模型内容身份，导入提交前与实际源码重新派生值比较。 */
  expectedSourceHash: string;
};

/**
 * 解析已确认的片场拖入目标。返回 `null` 表示该 identity 不是当前合法片场（调用方消费为明确失败）。
 *
 * 目标 identity 由宿主 accepted `queryDropTarget` 固定（最上层实际节点、来源排除），本函数
 * **不再**用私有矩形 (`pointInNode`) 复判或按规范矩形中心伪造鼠标点
 * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。宿主已保证目标
 * 在真实菱形范围内，这里只承担片场身份、来源与导入规划校验。
 *
 * - 拖动源节点被排除，不接收自身；
 * - 一旦命中片场，**整批**来源都必须受支持，否则返回拒绝（不静默跳过非法项）。
 */
export function resolveFilmSetDrop(
  canvas: ServerCanvas,
  sourceNodeIds: readonly string[],
  targetNodeId: string
): { ok: true; target: FilmSetDropTarget } | { ok: false; reason: string } | null {
  const excluded = new Set(sourceNodeIds);
  if (excluded.has(targetNodeId)) return null;
  const hit = canvas.document.nodes.find(
    (node) => node.id === targetNodeId && isFilmSetGroupNode(node, canvas.nodeData?.[node.id])
  );
  if (!hit) return null;

  const items: FilmSetDropSource[] = [];
  for (const sourceNodeId of sourceNodeIds) {
    const source = canvas.document.nodes.find((node) => node.id === sourceNodeId);
    if (!source || !IMPORTABLE_SOURCE_TYPES.has(source.type)) {
      return { ok: false, reason: FILM_SET_DROP_UNSUPPORTED_SOURCE };
    }
    const resolved = resolveSource(canvas, source);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    items.push(resolved.value);
  }
  if (items.length === 0) return { ok: false, reason: "没有可导入的来源" };
  return { ok: true, target: { canvasId: canvas.id, nodeId: hit.id, sources: items } };
}

/**
 * 这一批来源是否会被片场接收（纯判定，不解析内容）。
 *
 * 宿主的拖动提示用它决定是否为片场绘制接收提示：图片/视频在片场范围内拖动时**不**改亮
 * 片场，也不显示「放到此处加入片场」；释放仍由 `resolveFilmSetDrop` 消费为明确失败。
 */
export function filmSetAcceptsSources(
  canvas: ServerCanvas,
  targetNodeId: string,
  sourceNodeIds: readonly string[]
): boolean {
  const excluded = new Set(sourceNodeIds);
  if (excluded.has(targetNodeId) || sourceNodeIds.length === 0) return false;
  const hit = canvas.document.nodes.find(
    (node) => node.id === targetNodeId && isFilmSetGroupNode(node, canvas.nodeData?.[node.id])
  );
  if (!hit) return false;
  return sourceNodeIds.every((sourceNodeId) => {
    const source = canvas.document.nodes.find((node) => node.id === sourceNodeId);
    return Boolean(source && IMPORTABLE_SOURCE_TYPES.has(source.type));
  });
}

function resolveSource(
  canvas: ServerCanvas,
  source: Woohaa3CanvasSerializedNode
): { ok: true; value: FilmSetDropSource } | { ok: false; reason: string } {
  const data = canvas.nodeData[source.id];
  if (source.type !== "model3d") return { ok: false, reason: FILM_SET_DROP_UNSUPPORTED_SOURCE };
  const decoded = scriptModel3DNodeData(data);
  if (!decoded) return { ok: false, reason: "文件模型不支持导入片场" };
  return {
    ok: true,
    value: {
      kind: "model",
      itemId: createHighEntropyId("film-object"),
      name: typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "模型",
      sourceNodeId: source.id,
      expectedSourceHash: decoded.model.contentVersion.sourceHash
    }
  };
}

/** 生成稳定导入请求 id（重试落到同一请求；新拖入生成新请求）。 */
export function createFilmSetImportRequestId(): string {
  return createHighEntropyId("film-import");
}

/**
 * 从权威画布把一次拖入快照化为 `nodeData.patch` 命令
 * （change design D4）。纯函数：读取片场当前内容、规划错开布局并追加导入对象；不涉及
 * 来源移动。来源或目标不满足前置条件时返回稳定失败（调用方回退为不导入、源回位）。
 */
export function planFilmSetImportCommand(input: {
  canvas: ServerCanvas;
  target: FilmSetDropTarget;
  now: string;
}): { ok: true; value: FilmSetGroupMarker; commands: CanvasCommand[] } | { ok: false; reason: string } {
  const marker = readFilmSetGroupMarker(input.canvas.nodeData[input.target.nodeId]);
  const animation = readFilmSetAnimationProjection(input.canvas, input.target.nodeId);
  if (!marker || !animation) return { ok: false, reason: "片场群组无法解析" };
  const drafts: FilmSetImportItemDraft[] = [];
  for (const source of input.target.sources) {
    const resolved = resolveDraft(input.canvas, source);
    if (!resolved.ok) return resolved;
    drafts.push(resolved.value);
  }
  const planned = planFilmSetImportItems({
    existingItems: animation.filmSetContent.items,
    drafts,
    importedAt: input.now
  });
  if (!planned.ok) return { ok: false, reason: planned.reason };
  const value = createFilmSetGroupMarker(marker);
  const commands: CanvasCommand[] = [];
  for (const item of planned.items) {
    const source = input.target.sources.find(source => source.itemId === item.id)!;
    const contentKey = contentKeyForFilmSetGroupSource(input.canvas, source.sourceNodeId);
    if (!contentKey) return { ok: false, reason: "来源内容身份不可用" };
    const t = item.localTransform;
    value.sceneBindings.push({ bindingId: item.id, sourceNodeId: source.sourceNodeId, kind: "model3d", name: item.name, contentKey, visibility: true, transform: { x: t.offset.x, y: t.offset.y, z: t.offset.z, yaw: t.yaw, scale: t.scale } });
    commands.push({ type: "node.update", nodeId: source.sourceNodeId, parentId: input.target.nodeId });
  }
  commands.push({ type: "nodeData.patch", nodeId: input.target.nodeId, expectedNodeData: Object.fromEntries([input.target.nodeId, ...input.target.sources.map(source => source.sourceNodeId)].map(id => [id, input.canvas.nodeData[id] ?? null])), value: { filmSetGroup: value } as import("@woohaa3/contracts").CanvasNodeData });
  return { ok: true, value, commands };
}

function resolveDraft(
  canvas: ServerCanvas,
  source: FilmSetDropSource
): { ok: true; value: FilmSetImportItemDraft } | { ok: false; reason: string } {
  const node = canvas.document.nodes.find((entry) => entry.id === source.sourceNodeId);
  if (!node || node.type !== "model3d") return { ok: false, reason: "来源模型不存在" };
  const decoded = scriptModel3DNodeData(canvas.nodeData[node.id]);
  if (!decoded) return { ok: false, reason: "文件模型不支持导入片场" };
  // 与实际源码重新派生哈希比较，避免客户端声明的旧内容身份掩盖源码变化。
  if (modelSourceHash(decoded.model.modelScript) !== source.expectedSourceHash) {
    return { ok: false, reason: "来源模型已变化，请重新导入" };
  }
  return {
    ok: true,
    value: {
      id: source.itemId,
      source: { kind: "model", name: source.name, model: decoded.model },
      origin: { sourceNodeId: source.sourceNodeId }
    }
  };
}

/** 构造导入后的 `nodeData.patch` 命令值。 */
export function filmSetImportPatchValue(marker: FilmSetGroupMarker): Record<string, unknown> {
  return { filmSetGroup: marker };
}
