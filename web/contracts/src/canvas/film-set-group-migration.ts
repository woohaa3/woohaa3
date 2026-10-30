import { getWoohaa3CanvasNodeAbsolutePosition } from "./domain/core/group-geometry.js";
/** Explicit, pure offline boundary for old film-set snapshots. */
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";
import { decodeModelDefinition } from "./model-definition.js";
import { isGroupBadgeScale } from "./group-badge.js";
import { planFilmSetMemberGrid } from "./film-set-group-member-layout.js";
import { decodeFilmSetGroupClip, decodeFilmSetGroupTransform, createFilmSetGroupMarker, decodeFilmSetGroupMarker, readFilmSetGroupMarker, validateFilmSetGroupBindings, contentKeyForFilmSetGroupSource, FILM_SET_GROUP_DEFAULT_BADGE_SCALE, FILM_SET_GROUP_MIGRATION_VERSION, type FilmSetGroupCamera, type FilmSetGroupClip, type FilmSetGroupDiagnostic, type FilmSetGroupMigrationResult, type FilmSetGroupMigrationOptions, type FilmSetGroupSceneBinding } from "./film-set-group.js";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/**
 * Atomically converts one legacy film-set composite into a group.  The input
 * canvas is never mutated.  The loose reader intentionally only understands
 * the old persisted snapshot shape; all successful output is marker + cards.
 */
/**
 * 补齐片场 group 缺省的 3D 徽标倍率：场景画在徽标里，1 倍会让迁移后的片场看起来突然很小。
 * 已经迁移过的画布在下一次启动时补一次；显式设置过（含用户缩小）的倍率保持不变。
 */
export function ensureFilmSetGroupBadgeScale(canvas: ServerCanvas): { canvas: ServerCanvas; changed: boolean } {
  let changed = false;
  const nodeData: Record<string, CanvasNodeData> = { ...canvas.nodeData };
  for (const node of canvas.document.nodes) {
    if (node.type !== "group") continue;
    const data = nodeData[node.id] as Record<string, unknown> | undefined;
    if (!data || !readFilmSetGroupMarker(data)) continue;
    if (typeof data.groupBadgeScale === "number" && isGroupBadgeScale(data.groupBadgeScale)) continue;
    nodeData[node.id] = { ...data, groupBadgeScale: FILM_SET_GROUP_DEFAULT_BADGE_SCALE } as CanvasNodeData;
    changed = true;
  }
  return changed ? { canvas: { ...canvas, nodeData }, changed } : { canvas, changed };
}

export function migrateLegacyFilmSetToGroup(canvas: ServerCanvas, legacyNodeId: string, options: FilmSetGroupMigrationOptions): FilmSetGroupMigrationResult {
  const legacy = canvas.document.nodes.find(node => node.id === legacyNodeId);
  const legacyData = canvas.nodeData[legacyNodeId] as Record<string, unknown> | undefined;
  const existingMarker = legacy && legacy.type === "group" ? readFilmSetGroupMarker(legacyData) : null;
  if (existingMarker?.migration?.commandId === options.commandId) {
    return { ok: true, canvas, groupId: legacyNodeId, createdNodeIds: [], diagnostics: [], duplicate: true };
  }
  if (!legacy || legacy.type !== "composite-asset") return { ok: false, reason: "旧片场节点不存在", diagnostics: [] };
  if (legacyData?.filmSetGroup && readFilmSetGroupMarker(legacyData)) return { ok: true, canvas, groupId: legacyNodeId, createdNodeIds: [], diagnostics: [], duplicate: true };
  const rawContent = legacyData?.filmSetContent;
  if (!object(rawContent) || !Array.isArray(rawContent.items)) return { ok: false, reason: "旧片场内容缺失，迁移未修改画布", diagnostics: [] };
  const items = rawContent.items;
  const idFactory = options.idFactory ?? ((kind, sourceId, index) => `${sourceId}-${kind}-${index + 1}`);
  const nodes = canvas.document.nodes.map(node => ({ ...node, position: { ...node.position } }));
  const nodeData: Record<string, CanvasNodeData> = { ...canvas.nodeData };
  const bindings: FilmSetGroupSceneBinding[] = [];
  const createdNodeIds: string[] = [];
  const diagnostics: FilmSetGroupDiagnostic[] = [];
  const canvasById = new Map(canvas.document.nodes.map(node => [node.id, node]));
  /** 卡片是否已在这个旧片场的成员闭包里（可作为本片场成员直接接管）。 */
  const insideLegacy = (nodeId: string): boolean => {
    const guard = new Set<string>([nodeId]);
    let cursor = canvasById.get(nodeId)?.parentId;
    while (cursor && !guard.has(cursor)) {
      if (cursor === legacyNodeId) return true;
      guard.add(cursor);
      cursor = canvasById.get(cursor)?.parentId;
    }
    return false;
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!object(item) || typeof item.id !== "string" || typeof item.kind !== "string") {
      diagnostics.push({ bindingId: `legacy-${index}`, sourceNodeId: legacyNodeId, code: "invalid-marker", message: "旧片场对象快照不可物化" });
      return { ok: false, reason: "旧片场对象快照不可物化", diagnostics };
    }
    const kind = item.kind === "model" ? "model3d" : item.kind === "image" || item.kind === "video" ? item.kind : null;
    if (!kind) {
      if (item.kind === "ground") continue;
      return { ok: false, reason: `未知旧片场对象类型：${item.kind}`, diagnostics };
    }
    let sourceNodeId: string | undefined;
    const origin = object(item.origin) ? item.origin : undefined;
    if (origin && typeof origin.sourceNodeId === "string") {
      const source = canvasById.get(origin.sourceNodeId);
      if (source && source.type === kind) {
        // 卡片是片场成员，而成员只有一个父级：只接管本来就没有归属、或已经属于本旧片场
        // 闭包的卡片。已经属于其它 group / 其它片场的卡片留在原处，本片场改用内容相同的
        // 副本，避免把别人的成员「偷」过来（否则对方片场的 binding 会失去成员、下一次
        // 规范化会整块丢弃它的 marker）。
        if (!source.parentId || insideLegacy(source.id)) sourceNodeId = source.id;
        else {
          const copyId = idFactory(kind, legacyNodeId, index);
          const existingCopy = nodes.find(node => node.id === copyId);
          if (existingCopy) {
            // 幂等：上一次迁移可能已经建好这张卡片、但标记没落盘就中断了（进程被杀 / 崩溃）。
            // id 是确定性的，所以同类型就认定是同一张卡片，直接复用；类型不同说明画布状态
            // 与迁移假设矛盾，仍然明确失败而不是猜。
            if (existingCopy.type !== kind) return { ok: false, reason: `资源卡片 ID 冲突：${copyId}`, diagnostics };
            diagnostics.push({ bindingId: String(item.id), sourceNodeId: source.id, code: "reused-existing-card", message: "该卡片已由上一次迁移创建，按幂等复用" });
          } else {
            const world = getWoohaa3CanvasNodeAbsolutePosition(source, canvasById);
            const copyData = { ...(nodeData[source.id] ?? {}) } as Record<string, unknown>;
            delete copyData.filmSetObject;
            nodes.push({
              id: copyId, type: kind, position: world,
              width: source.width ?? 260, height: source.height ?? 195,
              ...(typeof source.zIndex === "number" ? { zIndex: source.zIndex } : {})
            });
            nodeData[copyId] = copyData as CanvasNodeData;
            createdNodeIds.push(copyId);
            diagnostics.push({ bindingId: String(item.id), sourceNodeId: source.id, code: "shared-source", message: "来源卡片已属于其它容器，当前片场改用内容相同的副本" });
          }
          sourceNodeId = copyId;
        }
      } else diagnostics.push({ bindingId: String(item.id), sourceNodeId: String(origin.sourceNodeId), code: "type-mismatch", message: "来源卡片不存在或类型不匹配，改用快照物化" });
    }
    if (!sourceNodeId) {
      const cardId = idFactory(kind, legacyNodeId, index);
      const existingCard = nodes.find(node => node.id === cardId);
      if (existingCard) {
        // 与上面的副本分支同一口径：确定性 id 已存在且类型一致 → 上一次迁移的产物，复用。
        if (existingCard.type !== kind) return { ok: false, reason: `资源卡片 ID 冲突：${cardId}`, diagnostics };
        diagnostics.push({ bindingId: String(item.id), sourceNodeId: legacyNodeId, code: "reused-existing-card", message: "该卡片已由上一次迁移创建，按幂等复用" });
      } else {
        const sourceNode: Woohaa3CanvasSerializedNode = { id: cardId, type: kind, ...(legacy.parentId ? { parentId: legacy.parentId } : {}), position: { x: legacy.position.x + 32 + index * 24, y: legacy.position.y + 32 }, width: 260, height: 195 };
        nodes.push(sourceNode);
        createdNodeIds.push(cardId);
        const snapshot = object(item.model) ? item.model : {};
        const { contentVersion, placement, ...modelFields } = snapshot;
        nodeData[cardId] = kind === "model3d" ? { ...modelFields, ...Object.fromEntries([["modelContentVersion", contentVersion], ["modelPlacement", placement]].filter(([, value]) => value !== undefined)), title: typeof item.name === "string" ? item.name : "模型" } : { title: typeof item.name === "string" ? item.name : (kind === "image" ? "图片" : "视频"), ...(typeof item.assetId === "string" ? { outputAssetId: item.assetId } : {}) };
      }
      sourceNodeId = cardId;
    }
    if (kind === "model3d" && !decodeModelDefinition(nodeData[sourceNodeId]).ok) return { ok: false, reason: `模型对象 ${item.id} 的来源或快照不完整`, diagnostics };
    if (kind !== "model3d" && typeof nodeData[sourceNodeId]?.outputAssetId !== "string") return { ok: false, reason: `媒体对象 ${item.id} 缺少稳定资产`, diagnostics };
    const transform = object(item.localTransform) ? item.localTransform : {};
    const offset = object(transform.offset) ? transform.offset : {};
    const t = { x: finite(offset.x) ? offset.x : 0, y: finite(offset.y) ? offset.y : 0, z: finite(offset.z) ? offset.z : 0, yaw: finite(transform.yaw) ? transform.yaw as number : 0, scale: finite(transform.scale) && (transform.scale as number) > 0 ? transform.scale as number : 1 };
    const sourceNode = nodes.find(node => node.id === sourceNodeId)!;
    const sourceKey = contentKeyForFilmSetGroupSource({ ...canvas, document: { ...canvas.document, nodes }, nodeData }, sourceNode.id);
    bindings.push({ bindingId: String(item.id), ...(typeof item.name === "string" && item.name.trim() ? { name: item.name } : {}), sourceNodeId, kind, transform: t, visibility: true, contentKey: sourceKey ?? `legacy:${legacyNodeId}:${String(item.id)}` });
  }
  const groupId = options.groupId ?? `${legacyNodeId}-group`;
  if (nodes.some(node => node.id === groupId && node.id !== legacyNodeId)) return { ok: false, reason: `group ID 冲突：${groupId}`, diagnostics };
  const rawAnimations = object(legacyData?.filmSetAnimations) ? legacyData.filmSetAnimations : undefined;
  const rawClips = rawAnimations && Array.isArray(rawAnimations.clips) ? rawAnimations.clips : [];
  const clips: FilmSetGroupClip[] = [];
  const cameras: FilmSetGroupCamera[] = [];
  const sceneCamera = legacyData?.sceneCamera;
  if (object(sceneCamera) && finite(sceneCamera.azimuth) && finite(sceneCamera.elevation) && finite(sceneCamera.distance) && object(sceneCamera.focusOffset)
    && finite(sceneCamera.focusOffset.x) && finite(sceneCamera.focusOffset.y) && finite(sceneCamera.focusOffset.z)) {
    cameras.push({ id: "scene-camera", name: "场景镜头", azimuth: sceneCamera.azimuth, elevation: sceneCamera.elevation, distance: sceneCamera.distance,
      focusOffset: { x: sceneCamera.focusOffset.x, y: sceneCamera.focusOffset.y, z: sceneCamera.focusOffset.z }, ...(typeof sceneCamera.aspect === "string" ? { aspect: sceneCamera.aspect } : {}) });
  }
  for (const rawClip of rawClips) {
    if (!object(rawClip) || typeof rawClip.id !== "string") continue;
    const camera = object(rawClip.initialCamera) ? rawClip.initialCamera : undefined;
    const cameraId = camera ? `camera:${rawClip.id}` : undefined;
    if (camera && finite(camera.azimuth) && finite(camera.elevation) && finite(camera.distance) && object(camera.focusOffset)
      && finite(camera.focusOffset.x) && finite(camera.focusOffset.y) && finite(camera.focusOffset.z)) {
      cameras.push({ id: cameraId!, name: typeof rawClip.name === "string" ? rawClip.name : undefined, azimuth: camera.azimuth, elevation: camera.elevation, distance: camera.distance, focusOffset: { x: camera.focusOffset.x, y: camera.focusOffset.y, z: camera.focusOffset.z }, ...(typeof camera.aspect === "string" ? { aspect: camera.aspect } : {}) });
    }
    const timeline = object(rawClip.timeline) ? rawClip.timeline : undefined;
    const clip = decodeFilmSetGroupClip({ id: rawClip.id, ...(typeof rawClip.name === "string" ? { name: rawClip.name } : {}), ...(cameraId ? { cameraId } : {}), ...(timeline && finite(timeline.duration) ? { duration: timeline.duration } : {}) , loop: timeline?.loop, backdrop: rawClip.backdrop, cameraMotion: rawClip.cameraMotion, bindings: rawClip.bindings });
    if (!clip) return { ok: false, reason: `镜头 ${rawClip.id} 无法无损迁移`, diagnostics };
    clips.push(clip);
  }
  const groundItem = items.find(item => object(item) && item.kind === "ground");
  const ground = groundItem && object(groundItem.size) && finite(groundItem.size.width) && finite(groundItem.size.depth)
    ? { width: groundItem.size.width, depth: groundItem.size.depth, ...(typeof groundItem.color === "string" ? { color: groundItem.color } : {}) }
    : undefined;
  const root = object(legacyData?.scenePlacement) ? legacyData.scenePlacement : undefined;
  const rootOffset = root && object(root.offset) ? root.offset : undefined;
  const sceneTransform = root ? decodeFilmSetGroupTransform({ x: rootOffset?.x, y: rootOffset?.y, z: rootOffset?.z, yaw: root.yaw, scale: root.scale }) : undefined;
  if (sceneTransform === null) return { ok: false, reason: "旧片场根摆放非法", diagnostics };
  if (ground && object(groundItem) && object(groundItem.localTransform)) {
    const local = groundItem.localTransform, offset = object(local.offset) ? local.offset : {};
    const transform = decodeFilmSetGroupTransform({ x: offset.x, y: offset.y, z: offset.z, yaw: local.yaw, scale: local.scale });
    if (!transform) return { ok: false, reason: "旧片场地面摆放非法", diagnostics };
    Object.assign(ground, { transform });
  }
  const marker = createFilmSetGroupMarker({ sceneBindings: bindings, ...(sceneTransform ? { sceneTransform } : {}), ...(cameras.length ? { cameras } : {}), ...(clips.length ? { clips } : {}), ...(rawAnimations && typeof rawAnimations.defaultClipId === "string" ? { activeClip: rawAnimations.defaultClipId } : {}), ...(ground ? { ground } : {}), migration: { version: FILM_SET_GROUP_MIGRATION_VERSION, commandId: options.commandId, sourceNodeId: legacyNodeId } });
  const decodedMarker = decodeFilmSetGroupMarker(marker);
  if (!decodedMarker.ok) return { ok: false, reason: decodedMarker.reason, diagnostics };
  const bindingSources = new Set(bindings.map(binding => binding.sourceNodeId));
  const obsolete = new Set<string>();
  for (const node of nodes) {
    const ownership = nodeData[node.id]?.filmSetObject as { filmSetNodeId?: string } | undefined;
    if (ownership?.filmSetNodeId === legacyNodeId && !bindingSources.has(node.id)) obsolete.add(node.id);
  }
  // Old shells may contain unmarked descendants from earlier schema revisions.
  // Keep actual binding sources; remove the complete obsolete owned subtree.
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) if (node.parentId && obsolete.has(node.parentId) && !bindingSources.has(node.id) && !obsolete.has(node.id)) {
      obsolete.add(node.id); changed = true;
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const managedNodeIds = new Set<string>();
  for (const node of nodes) {
    const data = nodeData[node.id] as Record<string, unknown> | undefined;
    if (!data) continue;
    const owned = (object(data.shotPreview) && data.shotPreview.filmSetNodeId === legacyNodeId)
      || (object(data.managedBy) && data.managedBy.ownerNodeId === legacyNodeId)
      || (object(data.mediaContent) && object(data.mediaContent.payload) && data.mediaContent.payload.filmSetNodeId === legacyNodeId);
    if (owned) managedNodeIds.add(node.id);
  }
  const groupWorld = getWoohaa3CanvasNodeAbsolutePosition(legacy, byId);
  // 规范文档不允许嵌套 group（`sanitizeSerializedParentIds` 会把嵌套 group 提升为顶层并烘焙
  // 世界坐标）。转换后的片场本身就是 group，所以直接产出提升后的形态：原来挂在某个 group 下
  // 的旧节点改用世界坐标并清掉 parentId。否则迁移结果在 Y.Doc 往返后会被规范化改写，启动迁移
  // 的自检会判定「规范化内容不一致」并拒绝开放画布。
  const nextGroup: Woohaa3CanvasSerializedNode = { ...legacy, id: groupId, type: "group", position: { ...groupWorld } };
  delete nextGroup.parentId;
  const filtered = nodes.filter(node => node.id !== legacyNodeId && !obsolete.has(node.id))
    .map(node => {
      if (bindingSources.has(node.id)) {
        const world = getWoohaa3CanvasNodeAbsolutePosition(node, byId);
        return { ...node, parentId: groupId, position: { x: world.x - groupWorld.x, y: world.y - groupWorld.y } };
      }
      const hoisted = Boolean(legacy.parentId) && node.parentId === legacy.parentId && managedNodeIds.has(node.id);
      if (hoisted) {
        // 片场被提升到顶层时，它受管的镜头预览 / 媒体节点跟着一起提升，保持「与 owner 同级」
        // 的既有约束（否则它们会留在原上层 group 里，与 owner 的父级不再相同）。
        const world = getWoohaa3CanvasNodeAbsolutePosition(node, byId);
        const next = { ...node, position: world };
        delete next.parentId;
        return next;
      }
      return node.parentId === legacyNodeId ? { ...node, parentId: groupId } : node;
    });
  filtered.push(nextGroup);
  // 成员卡片沿用的是它们**在片场坐标系里的原始摆放**（原点在片场中心，常是负偏移），而 group
  // 矩形还是旧卡片的位置和尺寸，直接当成员就会全散在气泡外面、气泡看着是空的。这里按网格把
  // 成员铺进气泡，并让 group 矩形正好包住网格（与 getGroupLayoutSizes 的最小尺寸同源），
  // 3D 徽标继续留在下方页脚。
  const memberGrid = planFilmSetMemberGrid({ nodes: filtered, groupId });
  if (memberGrid) {
    for (const node of filtered) {
      const position = memberGrid.positions.get(node.id);
      if (position) node.position = { x: position.x, y: position.y };
    }
    nextGroup.width = memberGrid.width;
    nextGroup.height = memberGrid.height;
  }
  for (const id of obsolete) delete nodeData[id];
  delete nodeData[legacyNodeId];
  const groupData = { ...legacyData };
  for (const field of ["extensionId", "filmSetContent", "filmSetAnimations", "scenePlacement", "sceneCamera", "modelScript", "modelScriptLanguage", "modelScriptVersion", "modelContentVersion", "modelPlacement", "modelCameras", "modelScriptStatus", "modelScriptError", "filmSetObject", "filmSetObjectContainersHidden", "filmSetShotPreviewsHidden", "camera", "timeline", "motion", "origin"]) delete groupData[field];
  // 片场场景显示在 3D 徽标里：没有显式倍率时给一个可见的默认值，避免迁移后看起来「模型非常小」。
  const badgeScale = typeof groupData.groupBadgeScale === "number" ? groupData.groupBadgeScale : FILM_SET_GROUP_DEFAULT_BADGE_SCALE;
  nodeData[groupId] = { ...groupData, filmSetGroup: marker, groupBadgeScale: badgeScale } as CanvasNodeData;
  // Preserve managed preview/media node identities while moving their owner
  // reference to the new group. This is part of the same pure migration
  // result, so callers can commit it as one Y.Doc transaction.
  for (const [nodeId, original] of Object.entries(nodeData)) {
    const data = original && typeof original === "object" ? { ...original } : original;
    if (!data || typeof data !== "object") continue;
    const preview = data.shotPreview;
    if (object(preview) && preview.filmSetNodeId === legacyNodeId) data.shotPreview = { ...preview, filmSetNodeId: groupId } as CanvasNodeData["shotPreview"];
    const managed = data.managedBy;
    if (object(managed) && managed.ownerNodeId === legacyNodeId) data.managedBy = { ...managed, ownerNodeId: groupId } as CanvasNodeData["managedBy"];
    const media = data.mediaContent;
    if (object(media) && object(media.payload) && media.payload.filmSetNodeId === legacyNodeId) data.mediaContent = { ...media, payload: { ...media.payload, filmSetNodeId: groupId } } as CanvasNodeData["mediaContent"];
    nodeData[nodeId] = data;
  }
  const next = { ...canvas, document: { ...canvas.document, nodes: filtered, edges: canvas.document.edges.filter(edge => !obsolete.has(edge.source) && !obsolete.has(edge.target)).map(edge => ({ ...edge, source: edge.source === legacyNodeId ? groupId : edge.source, target: edge.target === legacyNodeId ? groupId : edge.target })) }, nodeData };
  const validation = validateFilmSetGroupBindings(next, groupId, marker);
  if (validation) return { ok: false, reason: validation, diagnostics };
  return { ok: true, canvas: next, groupId, createdNodeIds, diagnostics };
}

