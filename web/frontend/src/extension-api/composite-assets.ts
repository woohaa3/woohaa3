/** Trusted, scope-owned composite asset adapters. Business identity is never inferred from content. */
import type { CanvasNodeData, FilmSetLocalTransform, NodeGenerationHistoryDetail, PreparedModelResource, ServerCanvas, BevyModelEditor, ModelCamera, BevyCompositeAssetCompositionInfo, BevyRenderNode, BevyAnimationPlayback, ModelMediaTimeMap, CompositeAssetGeometryQuality, CompositeAssetScopeShape, CompositeChildRelation, CompositeContainerPanel, CanvasRenderScene, ManagedNodeLifecycleAdapter } from "@woohaa3/contracts";
import { ManagedNodeLifecycleRegistry } from "@woohaa3/contracts";
export type CompositeAssetMediaSource = { planeId: string; nodeId: string; assetId: string; kind: "image" | "video"; playback?: ModelMediaTimeMap; sourceIdentity: string };
/** A valid content projection may have no 3D resource; null prepare means unavailable. */
export type CompositeAssetProjection = { resource?: PreparedModelResource; composition?: BevyCompositeAssetCompositionInfo; diagnostic?: string };
export type CompositeChildPresentation = CompositeChildRelation & {
  panel?: CompositeContainerPanel;
  /** Optional object inside the owner whose live bounds anchor the focus link. */
  sourceItemId?: string;
  /** Containers can route double-click back to their owning workspace. */
  focusOwner?: boolean;
  /** Explicit opt-in to closing this child presentation; defaults to false. */
  closable?: boolean;
};
export type CompositeAssetAdapter = {
  emptyPlaceholder?: import("@woohaa3/contracts").CompositeAssetEmptyPlaceholder;
  showEmptyPlaceholder?(nodeId: string, data: CanvasNodeData): boolean;
  extensionId: string;
  owner: string;
  matchesNode?(node: ServerCanvas["document"]["nodes"][number], data: CanvasNodeData): boolean;
  /**
   * 业务类型显示名（如「片场」「游戏炼丹炉」）。
   *
   * 由可信 adapter 按严格身份声明，宿主把结果作为复合资产节点的 `typeLabel` 下发，供渲染层在
   * 画布浮动名称面板中标注聚合节点的**业务类型**（change:
   * 2026-10-12-align-film-set-scope-with-isometric-grid）。缺省时回落到通用内容类型标签。
   */
  label?: string;
  /** Declare managed canvas containers and entity cards. The host owns common presentation/dragging. */
  children?(canvas: ServerCanvas, ownerNodeId: string): readonly CompositeChildPresentation[];
  /** Hide a managed child presentation without deleting its source content. */
  closeChild?(canvas: ServerCanvas, childNodeId: string): void;
  childLinkAnchor?: [number, number, number];
  /**
   * 通用范围形状**覆盖**声明（change: 2026-10-12-align-film-set-scope-with-isometric-grid，
   * design D3 修订）。
   *
   * 复合资产类别默认即 `isometric-diamond`（模型地面占地的等距范围）；adapter 一般无需声明。
   * 仅在需要按严格身份显示为轴对齐矩形时才声明 `rect`。未知值在 register 边界拒绝，不写规范 nodeData。
   */
  scopeShape?: CompositeAssetScopeShape;
  /** Per-node override. undefined uses the static declaration/category default. */
  scopeShapeForNode?(nodeId: string, data: CanvasNodeData): CompositeAssetScopeShape | undefined;
  /**
   * 总览 primitive LOD 策略声明
   * （change: 2026-10-15-add-film-set-overview-lod，design D1）。
   *
   * 可信 adapter 按严格身份声明 `overview-primitives-v1`，宿主把结果投影为复合资产节点的
   * `compositeAsset.geometryQuality`，或 group 徽标场景的 `group.geometryQuality`，运行时据此按
   * 实际世界投影尺寸选择整场图元细分。缺省即 World 用途保持 High；未知值在 register 边界拒绝，
   * 不从 nodeData 标题/items/动画或历史类型推断。
   */
  geometryQuality?: CompositeAssetGeometryQuality;
  /** Hosts pass nodeId; optional for existing callers that only have node data. */
  executionKey(data: CanvasNodeData, nodeId?: string): string;
  prepare(nodeId: string, data: CanvasNodeData): CompositeAssetProjection | null;
  mediaSources?(nodeId: string, data: CanvasNodeData, playback: BevyAnimationPlayback | null): CompositeAssetMediaSource[];
  projectCanvas?(canvas: ServerCanvas): ServerCanvas;
  /** Additional owned nodes that move with this node, without changing selection. */
  dragAlongNodeIds?(canvas: ServerCanvas, nodeId: string): readonly string[];
  history?(nodeId: string, detail: NodeGenerationHistoryDetail | null): boolean;
  historyProjection?(nodeId: string): CompositeAssetProjection | null;
  projectPresentation?(node: BevyRenderNode, data: CanvasNodeData, resource?: PreparedModelResource): void;
  objectPreview?(nodeId: string): { itemId: string; transform: FilmSetLocalTransform } | null;
  gizmo?(nodeId: string): BevyModelEditor | null;
  readCameras?(nodeId: string, data: CanvasNodeData): ModelCamera[];
  writeCameras?(nodeId: string, cameras: readonly ModelCamera[]): boolean;
  captureOrigin?(nodeId: string, cameraId: string): import("./model-workspace.js").ModelCaptureOrigin | null;
  awaitCaptureReady?(nodeId: string): Promise<boolean>;
  /** Business owner decides whether explicit frame capture is available for this target. */
  /** Freeze extension content for one capture; caller releases after the final readback. */
  beginCapture?(nodeId: string): () => void;
  captureEnabled?(nodeId: string, cameraId: string): boolean;
  /** Optional pure lifecycle planner for extension-owned managed media/entities. */
  managedLifecycle?: ManagedNodeLifecycleAdapter;
  blocksFocusInput?(): boolean;
  keydown?(event: KeyboardEvent, focusedNodeId: string | null): boolean;
};
export class CompositeAssetRegistry {
  readonly managedLifecycles = new ManagedNodeLifecycleRegistry();
  private revision = 0;
  getRevision = (): number => this.revision;
  private generations = new Map<string, number>();
  generation(extensionId: string): number { return this.generations.get(extensionId) ?? 0; }
  lifecycle(extensionId: string): ManagedNodeLifecycleAdapter | null { return this.adapters.get(extensionId)?.managedLifecycle ?? null; }
  private adapters = new Map<string, CompositeAssetAdapter>();
  private listeners = new Set<() => void>();
  private projectionOwners = new Map<string, string>();
  private projections = new Map<string, CompositeAssetProjection>();
  private scopeResults = new Map<string, { identity: string; owner: string; shape?: CompositeAssetScopeShape; diagnostic?: string }>();
  register(adapter: CompositeAssetAdapter): () => void {
    if (!adapter.extensionId || adapter.owner !== adapter.extensionId) throw new Error("复合资产 adapter owner 与业务身份不一致");
    if (this.adapters.has(adapter.extensionId)) throw new Error(`复合资产业务注册冲突：${adapter.extensionId}`);
    // 通用范围形状在 register 边界校验：未知值拒绝，不静默降级为矩形
    // （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3/D8）。
    if (adapter.scopeShape !== undefined && adapter.scopeShape !== "rect" && adapter.scopeShape !== "isometric-diamond") {
      throw new Error(`复合资产范围形状未知：${String(adapter.scopeShape)}`);
    }
    // 总览 LOD 策略同样在 register 边界校验：未知值拒绝，不静默忽略或降级
    // （change: 2026-10-15-add-film-set-overview-lod，design D1）。
    if (adapter.geometryQuality !== undefined && adapter.geometryQuality !== "overview-primitives-v1") {
      throw new Error(`复合资产几何质量策略未知：${String(adapter.geometryQuality)}`);
    }
    if (adapter.emptyPlaceholder !== undefined && adapter.emptyPlaceholder !== "brand-plinth-v1") throw new Error(`未知复合资产占位：${String(adapter.emptyPlaceholder)}`);
    if (adapter.managedLifecycle && adapter.managedLifecycle.extensionId !== adapter.extensionId) throw Error("托管生命周期与注册扩展身份不一致");
    const releaseLifecycle = adapter.managedLifecycle ? this.managedLifecycles.register(adapter.managedLifecycle) : () => {};
    this.adapters.set(adapter.extensionId, adapter); this.generations.set(adapter.extensionId, this.generation(adapter.extensionId) + 1); this.invalidate();
    let alive = true;
    return () => { if (!alive) return; alive = false; releaseLifecycle(); if (this.adapters.get(adapter.extensionId) === adapter) { this.adapters.delete(adapter.extensionId); for (const [id, owner] of this.projectionOwners) if (owner === adapter.extensionId) { this.projections.delete(id); this.projectionOwners.delete(id); } for (const [id, result] of this.scopeResults) if (result.owner === adapter.extensionId) this.scopeResults.delete(id); this.generations.set(adapter.extensionId, this.generation(adapter.extensionId) + 1); this.invalidate(); } };
  }
  resolve(canvas: ServerCanvas | null, nodeId: string): CompositeAssetAdapter | null {
    const node = canvas?.document.nodes.find(node => node.id === nodeId);
    return node && canvas ? this.resolveNode(canvas, node) : null;
  }
  /** Resolve an actual node from this canvas without searching the document again. */
  resolveNode(canvas: ServerCanvas, node: ServerCanvas["document"]["nodes"][number]): CompositeAssetAdapter | null {
    const identity = canvas.nodeData[node.id]?.extensionId;
    for (const adapter of this.adapters.values()) if (adapter.matchesNode?.(node, canvas.nodeData[node.id])) return adapter;
    const adapter = node.type === "composite-asset" && typeof identity === "string" ? this.adapters.get(identity) : null;
    return adapter && !adapter.matchesNode ? adapter : null;
  }
  setProjection(nodeId: string, projection: CompositeAssetProjection | null, owner?: string): void {
    if (projection) { this.projections.set(nodeId, projection); if (owner) this.projectionOwners.set(nodeId, owner); }
    else { this.projections.delete(nodeId); this.projectionOwners.delete(nodeId); }
  }
  projection(nodeId: string): CompositeAssetProjection | null { return this.projections.get(nodeId) ?? null; }
  /**
   * 按严格身份解析每个复合资产节点的范围形状**覆盖**声明
   * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3 修订）。
   *
   * 复合资产类别默认即 `isometric-diamond`；只有在可信 adapter 显式覆盖时才写入（例如 `rect`）。
   * 宿主把结果注入共享 scene mapper（与 working position/size 同源派生），避免只在
   * `projectPresentation` 后改外观导致查询看不到形状。
   */
  scopeShapes(canvas: ServerCanvas | null): ReadonlyMap<string, CompositeAssetScopeShape> {
    const shapes = new Map<string, CompositeAssetScopeShape>();
    if (!canvas) { this.scopeResults.clear(); return shapes; }
    const retained = new Set<string>();
    for (const node of canvas.document.nodes) {
      const adapter = this.resolveNode(canvas, node);
      if (!adapter) continue;
      retained.add(node.id);
      const data = canvas.nodeData[node.id];
      // Content references are opaque to the host, but replacement must discard old fallback.
      const identity = JSON.stringify([canvas.id, adapter.extensionId, this.generation(adapter.extensionId), data?.extensionContentRef]);
      const previous = this.scopeResults.get(node.id);
      let shape = previous?.identity === identity ? previous.shape : adapter.scopeShape;
      let diagnostic: string | undefined;
      try {
        const resolved = adapter.scopeShapeForNode?.(node.id, data);
        if (resolved !== undefined && resolved !== "rect" && resolved !== "isometric-diamond") throw new Error(`未知范围形状：${String(resolved)}`);
        shape = resolved ?? adapter.scopeShape;
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error);
        if (previous?.identity !== identity || previous.diagnostic !== diagnostic) console.warn(`Composite asset scope ${node.id}: ${diagnostic}`);
      }
      this.scopeResults.set(node.id, { identity, owner: adapter.extensionId, shape, diagnostic });
      if (shape) shapes.set(node.id, shape);
    }
    for (const id of this.scopeResults.keys()) if (!retained.has(id)) this.scopeResults.delete(id);
    for (const child of this.children(canvas).values()) if (child.kind === "container") shapes.set(child.nodeId, "rect");
    return shapes;
  }
  scopeDiagnostic(nodeId: string): string | null { return this.scopeResults.get(nodeId)?.diagnostic ?? null; }
  /**
   * 按严格身份解析每个复合资产节点的**总览 primitive LOD 策略声明**
   * （change: 2026-10-15-add-film-set-overview-lod，design D1）。
   *
   * 只有可信 adapter 显式声明 `overview-primitives-v1` 时才写入；宿主把它注入 scene mapper，
   * 运行时据此按世界投影尺寸选择整场图元细分。未声明（炉体、第三方、普通卡片）不写入，World
   * 用途保持 High。不从 nodeData 标题、items 形状、动画或历史类型推断。
   */
  emptyPlaceholders(canvas: ServerCanvas | null): ReadonlyMap<string, import("@woohaa3/contracts").CompositeAssetEmptyPlaceholder> {
    const placeholders = new Map<string, import("@woohaa3/contracts").CompositeAssetEmptyPlaceholder>();
    if (!canvas) return placeholders;
    for (const node of canvas.document.nodes) {
      const adapter = this.resolveNode(canvas, node);
      if (adapter?.emptyPlaceholder !== "brand-plinth-v1") continue;
      try {
        if (adapter.showEmptyPlaceholder?.(node.id, canvas.nodeData[node.id]) === true) placeholders.set(node.id, adapter.emptyPlaceholder);
      } catch { /* Invalid content cannot imply emptiness. */ }
    }
    return placeholders;
  }
  geometryQualities(canvas: ServerCanvas | null): ReadonlyMap<string, CompositeAssetGeometryQuality> {
    const qualities = new Map<string, CompositeAssetGeometryQuality>();
    if (!canvas) return qualities;
    for (const node of canvas.document.nodes) {
      const adapter = this.resolveNode(canvas, node);
      if (adapter?.geometryQuality) qualities.set(node.id, adapter.geometryQuality);
    }
    return qualities;
  }
  /**
   * 按严格身份解析每个复合资产节点的**业务类型显示名**（如「片场」「游戏炼丹炉」）。
   *
   * 由可信 adapter 的 `label` 声明；宿主把它作为该节点的 `typeLabel` 注入 scene mapper，让画布
   * 浮动名称面板标注聚合节点的业务类型，而不是通用「复合资产」
   * （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。未声明 `label` 的节点不写入，
   * mapper 回落到通用内容类型标签。
   */
  typeLabels(canvas: ServerCanvas | null): ReadonlyMap<string, string> {
    const labels = new Map<string, string>();
    if (!canvas) return labels;
    for (const node of canvas.document.nodes) {
      const adapter = this.resolveNode(canvas, node);
      if (adapter?.label?.trim()) labels.set(node.id, adapter.label.trim());
    }
    return labels;
  }
  mediaSources(canvas: ServerCanvas | null, playback: BevyAnimationPlayback | null): CompositeAssetMediaSource[] {
    if (!canvas) return [];
    return canvas.document.nodes.flatMap(node => {
      const adapter = this.resolveNode(canvas, node);
      if (!adapter) return [];
      return (adapter.mediaSources?.(node.id, canvas.nodeData[node.id], playback) ?? []).filter(source => source.nodeId === node.id).map(source => ({ ...source, sourceIdentity: `${canvas.id}:${adapter.extensionId}:${this.generation(adapter.extensionId)}:${source.sourceIdentity}` }));
    });
  }
  compositions(): ReadonlyMap<string, BevyCompositeAssetCompositionInfo> {
    return new Map([...this.projections].flatMap(([id, value]) => value.composition ? [[id, value.composition] as const] : []));
  }
  retain(nodeIds: ReadonlySet<string>): void {
    for (const id of this.projections.keys()) if (!nodeIds.has(id)) { this.projections.delete(id); this.projectionOwners.delete(id); }
    for (const id of this.scopeResults.keys()) if (!nodeIds.has(id)) this.scopeResults.delete(id);
  }
  projectCanvas(canvas: ServerCanvas | null): ServerCanvas | null {
    if (!canvas) return null;
    for (const adapter of this.adapters.values()) if (adapter.projectCanvas) canvas = adapter.projectCanvas(canvas);
    return canvas;
  }
  children(canvas: ServerCanvas | null): ReadonlyMap<string, CompositeChildPresentation> {
    const children = new Map<string, CompositeChildPresentation>();
    if (!canvas) return children;
    const nodes = new Map(canvas.document.nodes.map(node => [node.id, node]));
    for (const owner of canvas.document.nodes) {
      const adapter = this.resolveNode(canvas, owner);
      if (!adapter?.children) continue;
      for (const child of adapter.children(canvas, owner.id)) {
        if (child.ownerNodeId !== owner.id || child.nodeId === owner.id || !nodes.has(child.nodeId)) continue;
        if (child.role !== "object-entry" && child.role !== "preview") continue;
        if (child.role === "preview" && (child.closable || child.focusOwner)) continue;
        if (child.kind !== "container" && child.kind !== "entity") continue;
        if (children.has(child.nodeId)) throw new Error(`复合资产子节点归属冲突：${child.nodeId}`);
        if (child.kind === "container" && !["composite-asset", "model3d"].includes(nodes.get(child.nodeId)?.type ?? "")) throw new Error("容器必须使用 composite-asset 或 model3d 节点");
        children.set(child.nodeId, child);
      }
    }
    return children;
  }
  closeChild(canvas: ServerCanvas, childNodeId: string): boolean {
    const child = this.children(canvas).get(childNodeId);
    const adapter = child && this.resolve(canvas, child.ownerNodeId);
    if (child?.closable !== true || !adapter?.closeChild) return false;
    adapter.closeChild(canvas, childNodeId);
    return true;
  }
  dragAlongNodeIds(canvas: ServerCanvas | null, ownerNodeId: string): string[] {
    return [...this.children(canvas).values()].filter(child => child.ownerNodeId === ownerNodeId && child.followOwner !== false).map(child => child.nodeId);
  }
  projectChildren(scene: CanvasRenderScene, canvas: ServerCanvas): void {
    const children = this.children(canvas), nodes = new Map(scene.nodes.map(node => [node.id, node]));
    const sourceNodes = new Map(canvas.document.nodes.map(node => [node.id, node]));
    const targets = new Map<string, string[]>();
    for (const child of children.values()) {
      const node = nodes.get(child.nodeId), owner = nodes.get(child.ownerNodeId);
      if (!node || !owner?.compositeAsset) continue;
      const ids = targets.get(child.ownerNodeId) ?? []; ids.push(child.nodeId); targets.set(child.ownerNodeId, ids);
      if (child.kind === "container" && node.compositeAsset) {
        node.compositeAsset.scopeShape = "rect";
        delete node.compositeAsset.scopeGround;
        node.compositeAsset.panel = child.panel ?? { title: node.title };
      }
    }
    for (const [ownerId, targetNodeIds] of targets) {
      const owner = nodes.get(ownerId)!;
      const targetItemIds = Object.fromEntries(targetNodeIds.flatMap(id => {
        const itemId = children.get(id)?.sourceItemId;
        return itemId ? [[id, itemId]] : [];
      }));
      const sourceOwner = sourceNodes.get(ownerId);
      owner.compositeAsset!.ownershipLinks = { anchor: (sourceOwner && this.resolveNode(canvas, sourceOwner)?.childLinkAnchor) ?? [0, 0, 0], targetNodeIds,
        ...(Object.keys(targetItemIds).length ? { targetItemIds } : {}) };
    }
    // Managed entities share the same ownership links as containers. Their media/shot renderer stays intact.
    //
    // 只有**片场复合资产**（composite-asset）内部的预览卡片才不需要镜头归属线：它们与其它子对象
    // 共用同一条 `ownershipLinks`，位置在复合场景里自洽。片场 group 是另一回事：预览卡片虽然
    // 由 group 托管（出现在 `children()` 里），但它浮在画布上、与徽标相隔很远，归属线是唯一
    // 的关联呈现——按子节点一律过滤会把 group 片场的归属线全部抹掉。
    const compositeOwnerIds = new Set([...nodes.values()].filter(node => node.compositeAsset).map(node => node.id));
    scene.shotPreviewLinks = scene.shotPreviewLinks?.filter(link => !(children.has(link.previewNodeId) && compositeOwnerIds.has(link.ownerNodeId))) ?? [];
  }
  blocksFocusInput(): boolean { return [...this.adapters.values()].some(adapter => adapter.blocksFocusInput?.()); }
  keydown(event: KeyboardEvent, canvas: ServerCanvas | null, nodeId: string | null): boolean { return nodeId ? this.resolve(canvas, nodeId)?.keydown?.(event, nodeId) ?? false : false; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  invalidate = (): void => { this.revision += 1; for (const listener of this.listeners) listener(); };
  clear(): void { this.managedLifecycles.clear(); this.adapters.clear(); this.projections.clear(); this.projectionOwners.clear(); this.scopeResults.clear(); this.invalidate(); }
}
