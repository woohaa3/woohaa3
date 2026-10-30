/**
 * 双击分派（图片/视频预览 + 模型聚焦）
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-2d-input 拆出）。
 *
 * 只从 canonical canvas 命中节点并解析其合法输出：
 * - image：ready/受控同源 → media-preview；video：ready + 稳定 storageKey → 只发 nodeId 截帧；
 * - 3D 模型/片场：双击模型或卡片进入聚焦，普通模型在画布上保留内嵌预览。
 */
import { screenToWorld, type Point } from "./hit-test.js";
import { modelBounds, type FocusHitResult } from "./model-focus-session.js";
import { resolveCanonicalMediaUrl } from "../media-preview/media-preview.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import type { InteractionCore } from "./interaction-core.js";
import { builtinNodeCapabilityResolver, shotPreviewOwnershipOf } from "@woohaa3/contracts";

export function createDoubleClickHandler(core: InteractionCore) {
  const { options, canvas, model, setSelection, activeViewport, surfaceSize } = core;

  /**
   * 空白处双击与空白处右键是同一入口：同一份菜单、同一个位置（屏幕 + 世界）。
   * 阻断条件与右键 fallback 一致——聚焦工作区（模型/视频）内空白双击不开画布菜单。
   */
  const openBlankContextMenu = (event: MouseEvent, world: Point) => {
    if (model.active || core.modalActive() || options.isVideoFocused?.()) return;
    event.preventDefault();
    options.onContextMenu?.({ screen: { x: event.clientX, y: event.clientY }, world, node: null });
  };

  const onDoubleClick = (event: MouseEvent) => {
    // 只有真正的 modal Dialog 阻断双击；非模态 editor/history panel 打开时仍允许双击
    // 模型进入聚焦（change: fix-model-focus-navigation-and-camera-parity，design D6）。
    if (core.focusInputBlocked()) return;
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // Focus references are visual only; a double click must not enter their card/shot.
    if (model.active && model.isFocusReferenceEvent(event)) { event.preventDefault(); return; }
    const world = screenToWorld(point, activeViewport());
    // 命中由 Rust interaction snapshot 计算；不可用时不派发卡片命中（design D3）。
    const hitResult = core.queryPoint(world, activeViewport().zoom);
    const hit = hitResult.ok ? hitResult.value : null;
    // 只有徽标本体（group-badge-select）是聚焦入口；其它组动作不进入容器聚焦。
    const badgeNodeId = hit?.kind === "node-action" && hit.actionId === "group-badge-select" ? hit.nodeId : null;
    const cardNodeId = hit && (hit.kind === "node" || hit.kind === "model-preview" || hit.kind === "film-scope") ? hit.nodeId : null;
    const canvasState = woohaa3CanvasStore.getState().canvas;
    if (!canvasState) return;
    const resolver = options.nodeCapabilities ?? builtinNodeCapabilityResolver;
    const contextOf = (id: string) => {
      const node = canvasState.document.nodes.find(node => node.id === id);
      return node ? { canvas: canvasState, node, data: canvasState.nodeData[id] } : null;
    };
    const capabilitiesOf = (id: string) => {
      const context = contextOf(id); return context ? resolver.resolve(context) : null;
    };
    const focusKind = (id: string) => {
      const context = contextOf(id); return context ? resolver.resolve(context).focus?.kind(context) : null;
    };
    // 模型徽标：双击直接进入容器聚焦（与画布横条「编辑」按钮同一入口）。只对有自己模型
    // 聚焦工作区的容器生效（片场）；普通 group 的徽标仍只负责选择/拖动与展开/收起。
    if (badgeNodeId) {
      event.preventDefault();
      const kind = focusKind(badgeNodeId);
      if (contextOf(badgeNodeId)?.node.type !== "group" || kind !== "model") return;
      setSelection([badgeNodeId]);
      if (options.onModelFocusIntent) {
        options.onModelFocusIntent({ type: "enter", nodeId: badgeNodeId, kind });
        return;
      }
      model.enterModelFocusForNode?.(badgeNodeId);
      return;
    }
    const cardEntry = cardNodeId
      ? canvasState.document.nodes.find((candidate) => candidate.id === cardNodeId)
      : undefined;

    // 拍摄镜头预览卡片：双击进入所属片场聚焦并选择该镜头（零点暂停）
    // （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.4 / design D8）。
    // 归属由 nodeData 严格解码得到；缺失/非法即不派发（保留节点与归属保护，不猜默认镜头）。
    if (cardEntry) {
      const ownership = shotPreviewOwnershipOf(canvasState.nodeData?.[cardEntry.id]);
      if (ownership) {
        event.preventDefault();
        options.onShotPreviewEnterIntent?.({
          previewNodeId: cardEntry.id,
          filmSetNodeId: ownership.filmSetNodeId,
          clipId: ownership.clipId
        });
        return;
      }
    }

    const child = cardEntry ? options.compositeAssets?.children(canvasState).get(cardEntry.id) : null;
    if (child?.kind === "container" && child.focusOwner && focusKind(child.ownerNodeId)) {
      event.preventDefault();
      setSelection([child.ownerNodeId]);
      options.onModelFocusIntent?.({ type: "enter", nodeId: child.ownerNodeId,
        kind: focusKind(child.ownerNodeId)! });
      return;
    }

    // 片场支持模型 picking；普通模型按内嵌预览卡片命中进入聚焦。
    // 命中由 Rust 相机/bounds/placement 派生（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    // 没有命中任何卡片，或命中的就是模型卡片时才尝试模型 picking。
    // 射线未打中网格时，双击模型卡片本身仍然进入：网格画在卡片下方，常被底部面板挡住。
    if (!cardNodeId || (cardEntry && !!focusKind(cardEntry.id))) {
      const surface = surfaceSize();
      const runtime = options.getRuntime();
      const generation = runtime?.interactionGeneration?.() ?? 0;
      const pick = runtime?.queryModelPick
        ? runtime.queryModelPick({ generation, x: point.x, y: point.y, width: surface.width, height: surface.height })
        : ({ ok: false as const, reason: "unavailable" as const });
      const meshHit: FocusHitResult | null = pick.ok && pick.value && !(cardEntry && !!capabilitiesOf(cardEntry.id)?.modelPreview)
        ? { ok: true, nodeId: pick.value.nodeId, target: pick.value.target, radius: pick.value.radius }
        : null;
      // 卡片回退：射线未命中网格但指针在模型卡片上时，仍进入聚焦（网格常被底部面板遮挡）。
      const cardFallback: FocusHitResult | null = !meshHit && cardEntry && !!focusKind(cardEntry.id)
        ? (() => {
            const targets = options.getModelFocusTargets?.() ?? [];
            const workingCanvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? canvasState;
            const target = targets.find(
              (candidate) => candidate.nodeId === cardEntry.id && candidate.canvas === workingCanvas
            );
            const bounds = target ? modelBounds(target) : null;
            return bounds ? { ok: true, nodeId: cardEntry.id, target: bounds.center, radius: bounds.radius } : null;
          })()
        : null;
      const resolved = meshHit ?? cardFallback;
      const canonicalType = resolved !== null
        ? canvasState.document.nodes.find((candidate) => candidate.id === resolved.nodeId)?.type
        : undefined;
      const canonical = resolved !== null && canonicalType !== undefined && !!focusKind(resolved.nodeId);
      if (resolved && canonical && canonicalType !== undefined) {
        event.preventDefault();
        setSelection([resolved.nodeId]);
        // 聚焦入口统一经 Canvas Navigation（design D7）；缺省回落到直接控制器调用（测试）。
        // 复合资产类别按严格业务身份（type + extensionId）选择工作区 kind：片场走宿主 model
        // 编辑器，炉体等其他业务走 extension 工作区（change: 2026-10-11-extract-film-set-extension，D11）。
        const kind = focusKind(resolved.nodeId)!;
        if (options.onModelFocusIntent) {
          options.onModelFocusIntent({ type: "enter", nodeId: resolved.nodeId, kind });
          return;
        }
        const entered = model.enterFromModelHit({
          nodeId: resolved.nodeId,
          target: resolved.target,
          radius: resolved.radius
        });
        if (entered) return;
      }
    }

    // 既有图片/视频双击分派需要命中卡片节点。
    if (!cardEntry) {
      // 画布空白处双击等价于空白处右键。命中查询不可用时保持无动作，
      // 不把「查不到」误当成空白。
      if (hitResult.ok && !hit) openBlankContextMenu(event, world);
      return;
    }

    const entry = cardEntry;
    const data = canvasState.nodeData?.[cardEntry.id] as { outputAssetId?: unknown; title?: unknown } | undefined;
    const outputId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
    const asset = outputId ? canvasState.assets.find((candidate) => candidate.id === outputId) : undefined;

    if (entry.type === "text") {
      event.preventDefault();
      options.onTextPreviewIntent?.({ nodeId: entry.id });
      return;
    }

    // 视频节点：优先原地聚焦（change: 2026-10-10-add-video-node-focus-workspace）；先暂停
    // 画布 hover 播放。缺省回落到既有截帧 Dialog（测试/未迁移宿主）。
    if (entry.type === "video") {
      if (!asset || asset.status !== "ready" || asset.mediaKind !== "video") return;
      const storageKey = typeof asset.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
      if (!storageKey) return;
      if (!resolveCanonicalMediaUrl(asset)) return;
      event.preventDefault();
      core.suspendHoverPlayback();
      options.videoSessions?.pauseAll();
      if (options.onVideoFocusIntent) {
        options.onVideoFocusIntent({ nodeId: entry.id });
        return;
      }
      options.onVideoFrameCapture?.({ nodeId: entry.id });
      return;
    }

    // 图片节点：双击进入画布内聚焦工作区（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
    if (entry.type !== "image") return;
    if (!asset || asset.status !== "ready" || asset.mediaKind !== "image") return;
    if (!resolveCanonicalMediaUrl(asset)) return;
    event.preventDefault();
    if (options.onImageFocusIntent) {
      options.onImageFocusIntent({ nodeId: entry.id });
      return;
    }
    // 缺省回落到既有 media-preview（测试/未迁移宿主）。
    options.onImagePreview?.({
      assetId: asset.id,
      nodeId: entry.id,
      title: typeof data?.title === "string" ? data.title : ""
    });
  };

  return { onDoubleClick };
}
