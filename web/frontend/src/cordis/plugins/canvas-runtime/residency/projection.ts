import { activeFilmSetSceneBindings, readFilmSetGroupMarker, contentKeyForFilmSetGroupSource, builtinNodeCapabilityResolver, effectiveCanvasNodeSize, type NodeCapabilityResolver } from "@woohaa3/contracts";
/**
 * 从 working 画布投影页面资源需求
 * （change: 2026-10-23-scale-canvas-media-residency，design D1/D7）。
 *
 * 唯一职责：把「文档 + 已接受视口 + surface + 当前交互」翻译成
 * `ResidencyProjectionInput`，交给 `CanvasResourceCoordinator` 准入。这里**不**创建媒体对象、
 * 不读像素、不写规范状态。
 *
 * 静止热路径（design D7 / 任务 7.1）：候选表按 working canvas 对象身份 memo；视口/选择/hover
 * 变化只重算需求分类，不重新解析资产 URL 或模型身份。文档变化（新对象）才重建候选表。
 */
import {
  getGroupLayoutSizes,
  hiddenByCollapsedGroups,
  groupBadgeRect
} from "@woohaa3/contracts";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { ContentKeyOf } from "./content-identity.js";
import type { CanvasResourceCoordinator } from "./coordinator.js";

/** 画布节点（渲染中立）：只依赖几何与父子关系，不读取 `data`。 */
type CanvasNode = ServerCanvas["document"]["nodes"][number];


export type ResidencyCandidate = {
  nodeId: string;
  contentKey: string;
  /** 世界坐标包围盒左上角。 */
  x: number;
  y: number;
  width: number;
  height: number;
  eligible: boolean;
  /** 总览中被收起组隐藏，聚焦/捕获 pin 可临时恢复内容需求。 */
  hiddenByGroup?: boolean;
  /**
   * 是否消耗「预览渲染槽」（离屏相机 + 渲染目标）。
   *
   * 只有模型与复合资产需要离屏预览相机；图片/视频的纹理是卡片贴图，不占预览槽。页级预算
   * 必须分开：`previewSlots` 是**预览渲染槽**上限（design D3），把它当成全页媒体准入上限会
   * 让视口内超过 16 个卡片时其余卡片永远不加载，只能靠 hover 变 interactive 才显示。
   */
  previewSlot: boolean;
};

/**
 * 从画布派生候选表（媒体、模型、组展示模型及复合资产节点）。
 *
 * `contentKeyOf` 提供稳定内容身份；返回 `null` 表示该节点目前没有可驻留内容（例如资产未
 * ready），此时 `eligible: false`，但节点仍留在表里，避免每帧重建候选结构。
 */
export function collectResidencyCandidates(
  canvas: ServerCanvas,
  contentKeyOf: ContentKeyOf,
  resolver: NodeCapabilityResolver = builtinNodeCapabilityResolver
): ResidencyCandidate[] {
  const byId = new Map<string, CanvasNode>(canvas.document.nodes.map((node) => [node.id, node]));
  const absolute = (node: CanvasNode): { x: number; y: number } => {
    let x = node.position.x;
    let y = node.position.y;
    let parentId = node.parentId;
    const guard = new Set<string>([node.id]);
    while (parentId && !guard.has(parentId)) {
      guard.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      x += parent.position.x;
      y += parent.position.y;
      parentId = parent.parentId;
    }
    return { x, y };
  };
  const groupSizes = getGroupLayoutSizes(canvas.document.nodes);
  const hidden = hiddenByCollapsedGroups(canvas);
  const candidates: ResidencyCandidate[] = [];
  for (const node of canvas.document.nodes) {
    const capabilities = resolver.resolve({ canvas, node, data: canvas.nodeData[node.id] });
    if (!capabilities.resources) continue;
    const size = groupSizes.get(node.id) ?? effectiveCanvasNodeSize(node, undefined, capabilities);
    const key = contentKeyOf(node);
    const frame = { ...absolute(node), ...size };
    const badge = node.type === "group" ? groupBadgeRect(frame, canvas.nodeData[node.id]?.groupBadgeScale) : null;
    const collapsed = canvas.nodeData[node.id]?.groupCollapsed === true;
    const rect = badge && collapsed ? badge : badge ? {
      x: Math.min(frame.x, badge.x),
      y: Math.min(frame.y, badge.y),
      width: Math.max(frame.x + frame.width, badge.x + badge.width) - Math.min(frame.x, badge.x),
      height: Math.max(frame.y + frame.height, badge.y + badge.height) - Math.min(frame.y, badge.y),
    } : frame;
    candidates.push({
      nodeId: node.id,
      contentKey: key ?? "",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      eligible: !hidden.has(node.id) && key !== null,
      hiddenByGroup: hidden.has(node.id),
      // 离屏预览相机只为模型/复合资产创建；图片与视频走卡片贴图，不占预览渲染槽。
      // 组模型直接绘制在画布世界（capability 声明 previewSlot: false）。
      previewSlot: capabilities.resources.previewSlot
    });
    // A film-set group owns scene entities whose residency identity follows
    // the source card. Keep one demand per binding so replacing a card version
    // cannot reuse the previous `(sourceNodeId, contentKey)` resource.
    const marker = node.type === "group" ? readFilmSetGroupMarker(canvas.nodeData[node.id]) : null;
    if (marker) {
      for (const binding of activeFilmSetSceneBindings(marker)) {
        const key = contentKeyForFilmSetGroupSource(canvas, binding.sourceNodeId);
        candidates.push({
          nodeId: `${node.id}:${binding.bindingId}`,
          contentKey: key ?? binding.contentKey,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          eligible: !hidden.has(node.id) && key !== null,
          hiddenByGroup: hidden.has(node.id),
          previewSlot: false
        });
      }
    }
  }
  return candidates;
}

/**
 * 候选表 memo：key 为 working canvas 对象身份 + 内容身份版本。
 *
 * selection / pan / zoom 不替换 working 对象，因此不重建；pending 重基或结构变化会替换对象，
 * 从而正确失效（与 `sharedCanvasNodeIndex` 同一口径）。
 *
 * 但**内容身份会独立于画布对象变化**：模型 prepared resource 是异步派生后写入 provider 的，
 * 画布对象不变而 `modelResourceKey` 从 null 变成真实 key。若只按画布对象 memo，首次投影发生在
 * 资源就绪之前时，候选表会永久停在「无内容、不可准入」，模型与片场 payload 永远拿不到需求，
 * 表现为「模型卡片一直不显示」「片场模型全部不显示」。因此调用方必须提供会随内容身份变化的
 * `contentVersion`（缺省 0 保持旧行为）。
 */
export function createResidencyCandidateCache(
  contentKeyOfOf: (canvas: ServerCanvas | null) => ContentKeyOf,
  contentVersion: () => number = () => 0,
  resolver: NodeCapabilityResolver = builtinNodeCapabilityResolver
): (canvas: ServerCanvas | null) => readonly ResidencyCandidate[] {
  let memoSource: ServerCanvas | null = null;
  let memoVersion = -1;
  let memoRegistryRevision = -1;
  let memo: readonly ResidencyCandidate[] = [];
  return (canvas) => {
    if (!canvas) return [];
    const version = contentVersion();
    if (canvas === memoSource && version === memoVersion && memoRegistryRevision === resolver.getRevision()) return memo;
    memoSource = canvas;
    memoVersion = version;
    memoRegistryRevision = resolver.getRevision();
    memo = collectResidencyCandidates(canvas, contentKeyOfOf(canvas), resolver);
    return memo;
  };
}

export type ResidencyProjectorInput = {
  coordinator: CanvasResourceCoordinator;
  getCanvas: () => ServerCanvas | null;
  candidatesFor: (canvas: ServerCanvas | null) => readonly ResidencyCandidate[];
  /**
   * 内容身份版本（模型/片场 prepared resource 就绪数等）。
   *
   * 异步资源就绪不会替换画布对象，但会把候选从「不可准入」变成「可准入」；版本进签名，
   * 静止帧才不会被误判为「投影未变」而永久跳过。
   */
  contentVersion?: () => number;
  viewport: () => { x: number; y: number; zoom: number };
  surface: () => { width: number; height: number; pixelRatio: number };
  /** 当前交互/播放/聚焦/捕获目标（interactive）。 */
  interactive: () => readonly string[];
  /** 显式 pin（聚焦过渡/严格输出）；缺省空。 */
  pins?: () => readonly string[];
  /** 页面是否可见；缺省读取 document.visibilityState。 */
  pageVisible?: () => boolean;
  /**
   * 准入集合的内容身份提交出口（当前用于模型 payload lease）；
   * 缺省不提交，调用方保持自己的驻留策略。
   */
  onAdmittedContent?: (contentKeys: readonly string[], revision: number) => void;
  /** 每帧收尾（准入集合未变时也调用）：推进有界的待准备/待上传队列。 */
  onFrame?: () => void;
};

/**
 * 每帧投影一次需求，并重置逐帧额度。
 *
 * 必须在媒体 owner 的 `sync()` 之前调用：先准入再创建（design D2 / 任务 2.1）。
 *
 * 静止热路径（design D7 / 任务 7.1）：视口、surface、画布身份、interactive/pin 集合都没变时
 * 复用上一帧准入结果，不重新遍历候选表（千节点文档的静止帧零全量投影）。
 */
export function createResidencyProjector(input: ResidencyProjectorInput): () => string[] {
  const { coordinator } = input;
  let lastSignature = "";
  let lastFresh: string[] = [];
  let lastLeaseRevision = -1;
  /** 只在新投影或准入集合变更时提交需求内容身份（静止帧零提交）。 */
  const submitLeases = () => {
    if (!input.onAdmittedContent) return;
    const revision = coordinator.projectionRevision();
    if (revision === lastLeaseRevision) return;
    lastLeaseRevision = revision;
    input.onAdmittedContent(coordinator.admittedContentKeys(), revision);
  };
  return () => {
    const canvas = input.getCanvas();
    const surface = input.surface();
    const viewport = input.viewport();
    const interactive = input.interactive();
    const pins = input.pins?.() ?? [];
    const validSurface = Number.isFinite(surface.width) && Number.isFinite(surface.height)
      && surface.width > 0 && surface.height > 0;
    const visible = input.pageVisible?.()
      ?? (globalThis.document?.visibilityState !== "hidden");
    const signature = [
      canvas?.id ?? "",
      // 画布对象身份即 revision/epoch 的直接体现：结构或内容变化才会替换对象。
      canvasKey(canvas),
      // 异步内容就绪（模型/片场 prepared resource）不替换画布对象，必须单独进签名。
      String(input.contentVersion?.() ?? 0),
      validSurface ? `${surface.width}x${surface.height}@${surface.pixelRatio}` : "no-surface",
      `${viewport.x},${viewport.y},${viewport.zoom}`,
      interactive.join(","),
      pins.join(","),
      visible ? "visible" : "hidden"
    ].join("|");
    if (signature === lastSignature) {
      coordinator.beginFrame();
      submitLeases();
      input.onFrame?.();
      return lastFresh;
    }
    lastSignature = signature;
    lastFresh = coordinator.project({
      viewport: validSurface ? viewport : null,
      surface: validSurface ? surface : null,
      pageVisible: visible,
      interactive,
      pins,
      // 聚焦继续访问原内容；退出聚焦后重新服从组的折叠呈现。
      candidates: pins.length ? input.candidatesFor(canvas).map(candidate => candidate.hiddenByGroup
        && candidate.contentKey && (pins.includes(candidate.nodeId) || interactive.includes(candidate.nodeId))
        ? { ...candidate, eligible: true } : candidate) : input.candidatesFor(canvas)
    });
    coordinator.beginFrame();
    submitLeases();
    input.onFrame?.();
    return lastFresh;
  };
}

/** working 画布对象身份（同对象视为同 revision）。 */
const canvasIdentities = new WeakMap<object, number>();
let nextCanvasIdentity = 1;
function identityOf(value: object): number {
  let identity = canvasIdentities.get(value);
  if (identity === undefined) {
    identity = nextCanvasIdentity++;
    canvasIdentities.set(value, identity);
  }
  return identity;
}
function canvasKey(canvas: ServerCanvas | null): string {
  return canvas ? String(identityOf(canvas)) : "";
}

/**
 * 画布结构指纹（O(1) 身份比较，不遍历节点/资产）。
 *
 * 用 `document.nodes`、`assets` 与 `nodeData` 对象身份 + revision：原地修改数组内容但复用同一
 * 对象属于调用方违约；规范路径每次变更都替换这些容器。媒体 owner 只在指纹变化时重建绑定。
 */
export function canvasStructureKey(canvas: ServerCanvas): string {
  return `${canvas.revision}|${identityOf(canvas.document.nodes)}|${identityOf(canvas.assets)}|${identityOf(canvas.nodeData)}`;
}
