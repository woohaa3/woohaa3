/**
 * 公共聚焦宿主
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D3/D4/D5）。
 *
 * 通用 focus 宿主：以**同一套贡献解析语义**为 Navigation preflight、Canvas Runtime owner
 * watcher 与 React 宿主提供「唯一 owner 解析 → 渲染工作区 / 可读诊断与受控返回」。
 *
 * - `resolveFocusWorkspace*` / `candidatesForFocus`：纯解析，跳过无匹配/多匹配/校验失败；
 * - `watchFocusWorkspace`：owner/内容/版本变化经既有失效路径释放（覆盖三类节点，不只 extension）；
 * - `FocusWorkspaceHost`：React 宿主，渲染唯一匹配贡献，缺失时呈现诊断与返回，且不与正常
 *   工作区重复呈现公共顶部栏。
 *
 * 只依赖 typed slot 契约、Navigation 契约与公共 focus 模块；MUST NOT import 具体 editor、
 * Canvas manifest 或 shell 的 React FocusWorkspace 实现。
 */
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CanvasNavigationService } from "../navigation/contracts.js";
import type { CanvasSlotProps, SlotContribution, SlotsService } from "../contract/platform.js";
import { useService } from "../react.js";
import { Button } from "../../shared/ui/Button.js";
import { useFocusLayoutSource } from "./workspace.js";

export type FocusWorkspaceEntry = SlotContribution<"canvas.focus-workspace">;

/** 唯一 owner 解析结果。 */
export type FocusWorkspaceResolution =
  | { ok: true; entry: FocusWorkspaceEntry }
  | { ok: false; reason: string };

export type FocusWorkspaceFocus = { nodeId: string; kind: string } | null | undefined;

/** 按当前聚焦身份过滤候选（kind 相等 + 可选 matchesFocus 严格匹配）。 */
export function candidatesForFocus(
  contributions: readonly FocusWorkspaceEntry[],
  canvas: ServerCanvas | null,
  focus: FocusWorkspaceFocus
): FocusWorkspaceEntry[] {
  if (!focus) return [];
  return contributions.filter(
    (entry) => entry.kind === focus.kind && (!entry.matchesFocus || entry.matchesFocus({ canvas, focus }))
  );
}

/**
 * 解析当前聚焦节点对应的唯一工作区 owner（含 validate）。
 * 无匹配 / 多个匹配 / validate 失败都返回不可进入原因；不按注册顺序裁决。
 */
export function resolveFocusWorkspaceEntry(
  contributions: readonly FocusWorkspaceEntry[],
  props: CanvasSlotProps
): FocusWorkspaceResolution {
  try {
    const owners = candidatesForFocus(contributions, props.canvas ?? null, props.focus ?? null);
    if (!owners.length) return { ok: false, reason: "此节点的工作区不可用，请检查对应扩展是否已启用。" };
    if (owners.length !== 1) return { ok: false, reason: "多个扩展声明了此节点的工作区，请检查扩展配置。" };
    const reason = owners[0]!.validate?.(props);
    return reason ? { ok: false, reason } : { ok: true, entry: owners[0]! };
  } catch {
    return { ok: false, reason: "扩展工作区校验失败，请检查扩展配置。" };
  }
}

/** 从 SlotsService 读取并解析唯一工作区（Navigation preflight 与 React 宿主共用）。 */
export function resolveFocusWorkspace(slots: Pick<SlotsService, "list">, props: CanvasSlotProps): FocusWorkspaceResolution {
  return resolveFocusWorkspaceEntry(slots.list("canvas.focus-workspace"), props);
}

/** 聚焦工作区是否激活（node-focus 且已解析唯一贡献）。 */
export function isFocusWorkspaceActive(mode: { type: string }, hasWorkspace: boolean): boolean {
  return mode.type === "node-focus" && hasWorkspace;
}

/**
 * 独立文档工作区是否有可用贡献（编辑扩展工作区）。
 *
 * 由 Canvas Runtime 的 focus adapter 用作 `isDocumentTargetValid`：没有贡献方的文档身份不能
 * 进入呈现，已撤下的贡献也不会继续占用活动呈现。
 */
export function documentWorkspaceAvailable(slots: Pick<SlotsService, "list">, documentId: string): boolean {
  const contributions = slots.list("canvas.document-workspace");
  const entry = contributions[0];
  if (!entry) return false;
  return entry.isAvailable ? entry.isAvailable(documentId) : true;
}

/**
 * 是否为 2D 媒体聚焦（图片/视频），其取景覆盖层在 extension 工作区聚焦时保留。
 *
 * 独立文档工作区（编辑扩展工作区）由编辑 feature 自己
 * 呈现不透明背景，不保留节点媒体取景覆盖层，避免双主图与事件穿透。
 */
export function showsMediaFocusOverlay(mode: { type: string; kind?: string }): boolean {
  return mode.type === "node-focus" && (mode.kind === "image" || mode.kind === "video");
}

/**
 * 丢失 owner 或内容/版本变化时经既有失效路径释放聚焦（覆盖三类节点，不只 extension）。
 */
export function watchFocusWorkspace(input: {
  slots: SlotsService;
  navigation: CanvasNavigationService;
  props: () => CanvasSlotProps;
  subscribeCanvas: (listener: () => void) => () => void;
}): () => void {
  let target: string | null = null;
  let owner: FocusWorkspaceEntry | null = null;
  let checking = false;
  const invalidate = (reason: string) => {
    checking = true;
    try { input.navigation.invalidateNodeFocus(reason); }
    finally { checking = false; target = null; owner = null; }
  };
  const reconcile = () => {
    if (checking) return;
    const props = input.props();
    const focus = props.focus ?? null;
    // 独立文档工作区没有节点身份：只校验贡献是否仍在（文档关闭由编辑 feature 主动收敛）。
    if (!focus) {
      const mode = input.navigation.getSnapshot().mode;
      if (mode.type === "document-workspace" && !documentWorkspaceAvailable(input.slots, mode.documentId)) {
        invalidate("文档工作区已关闭");
        return;
      }
      target = null;
      owner = null;
      return;
    }
    const result = resolveFocusWorkspace(input.slots, props);
    const sameTarget = target === focus.nodeId;
    if (!result.ok) {
      // 已建立 owner 的目标解析失败 → 经既有失效路径释放（owner 注销/校验失败/歧义）。
      // 尚未建立 owner 的瞬时不可用（图片/视频 editor 的会话由其导航监听异步创建，晚于本次
      // 发布）不是「owner 丢失」，不得在此抢先失效，否则刚进入的聚焦会被立即弹回。
      if (sameTarget && owner !== null) invalidate(result.reason);
      else { target = focus.nodeId; owner = null; }
      return;
    }
    // 同一目标下已解析的唯一 owner 发生变化（注销后由另一个贡献接管、内容/版本切换）→ 释放。
    if (sameTarget && owner !== null && owner !== result.entry) {
      invalidate("工作区已变更，请重新打开节点。");
      return;
    }
    target = focus.nodeId;
    owner = result.entry;
  };
  const disposers = [
    input.navigation.subscribe(reconcile),
    input.slots.subscribe("canvas.focus-workspace", reconcile),
    input.slots.subscribe("canvas.document-workspace", reconcile),
    input.subscribeCanvas(reconcile)
  ];
  reconcile();
  return () => disposers.forEach((dispose) => dispose());
}

export type FocusWorkspaceHostProps = CanvasSlotProps & {
  /**
   * 宿主已解析的唯一工作区（Navigation preflight 与 React 宿主共用同一语义）；省略时宿主自行解析。
   * 传入时避免重复解析，并让外层可据同一结果决定普通画布邻居的呈现。
   */
  workspace?: FocusWorkspaceResolution;
  /** 聚焦时按需保留的普通 overlay（连接栏/历史/提示等），由 shell 传入。 */
  overlays?: ReactNode;
  /** 2D 媒体取景覆盖层（图片/视频聚焦时保留），由 shell 传入。 */
  mediaOverlays?: ReactNode;
};

/**
 * 通用聚焦宿主：node-focus 时渲染唯一匹配的工作区贡献；无可用 owner 时呈现可读诊断与受控返回。
 *
 * 独立文档工作区（`document-workspace`）由编辑 feature 自己的 slot 呈现（见
 * `canvas.document-workspace`），这里不按文件文档伪造节点聚焦。
 *
 * 正常已挂载工作区与公共兜底**互斥**：兜底不渲染顶部栏；工作区贡献自行装配其 header。
 * 通用 overlay 的可见性由贡献的 `exclusive` 与聚焦身份统一裁决（design D3/D5）：独占工作区
 * 隐藏普通 overlay（保留 2D 媒体取景），非独占工作区保留公共连接栏/历史等贡献。
 */
export function FocusWorkspaceHost({ workspace, overlays, mediaOverlays, ...slotProps }: FocusWorkspaceHostProps) {
  const slots = useService("slots");
  const canvasNavigation = useService("canvasNavigation");
  useSyncExternalStore(
    (listener) => slots.subscribe("canvas.focus-workspace", listener),
    () => slots.version(),
    () => slots.version()
  );
  const contributions = slots.list("canvas.focus-workspace");
  const navigation = useSyncExternalStore(canvasNavigation.subscribe, canvasNavigation.getSnapshot, canvasNavigation.getSnapshot);
  const focus = navigation.mode.type === "node-focus"
    ? { nodeId: navigation.mode.nodeId, kind: navigation.mode.kind }
    : null;
  const resolved = workspace ?? resolveFocusWorkspaceEntry(contributions, { ...slotProps, focus });
  // 唯一工作区声明的布局来源（静态配置或可订阅快照）在此登记；缺省不改变公共默认。
  useFocusLayoutSource(resolved.ok ? resolved.entry.layout : undefined);
  if (resolved.ok) {
    const Component = resolved.entry.render;
    const exclusive = resolved.entry.exclusive === true;
    // 独占工作区隐藏普通 overlay，只在 2D 媒体聚焦（图片/视频）时保留媒体取景覆盖层。
    const media = exclusive && showsMediaFocusOverlay({ type: "node-focus", kind: focus?.kind }) ? mediaOverlays : null;
    return (
      <>
        <Component key={resolved.entry.id} {...slotProps} focus={focus} />
        {exclusive ? media : overlays}
      </>
    );
  }
  return (
    <>
      <div className="status-overlay" role="status">
        <div className="status-title">此节点的工作区不可用</div>
        <div className="status-detail">{resolved.reason}</div>
        <Button onClick={() => void canvasNavigation.requestExitNodeFocus()}>返回画布</Button>
      </div>
      {overlays}
    </>
  );
}
