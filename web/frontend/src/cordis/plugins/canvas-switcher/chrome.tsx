import { ScenePackageImport } from "../scene-experience/import-controls.js";
/**
 * Canvas Switcher chrome
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 4.1–4.5 / design D7；
 *  change: adopt-radix-lucide-canvas-ui 任务 4.2：迁移到生产 Button/IconButton/Tooltip/
 *  ScrollArea 与 Lucide icon facade）。
 *
 * 紧凑的画布 chrome：触发器显示当前标题；Dialog 提供分页列表、新建与当前画布重命名。
 * 保留 Canvas Catalog、create/switch/delete 与 Dialog Service ownership；模型聚焦时触发器
 * 让位左上角的聚焦返回按钮。
 *
 * 目录条目右侧渲染 `canvas.catalog-item-action` slot 的贡献（change: canvas 同步显式化）：
 * 宿主只做通用布局与上下文注入，不认识任何具体扩展，也不按扩展 ID 分支。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@woohaa3/ui/dialogs";
import { Button } from "@woohaa3/ui/primitives";
import { ScrollArea } from "@woohaa3/ui/primitives";
import { Tooltip } from "@woohaa3/ui/primitives";
import { CanvasSwitcherIcon, ChevronDownIcon, CloseIcon, SearchIcon } from "@woohaa3/ui/icons";
import type { DialogDefinition } from "../../services/dialogs/types.js";
import type { DialogRenderer, DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import type { CanvasCatalogService, CanvasSelectionService, CanvasSummary } from "../../contract/canvas-catalog.js";
import type { CanvasSession } from "../../contract/session.js";
import type { CanvasNavigationService } from "../../navigation/index.js";
import type { CanvasCreateOptionContribution, SlotsService } from "../../contracts.js";
import { ContributionBoundary } from "../../contribution-boundary.js";

export const CANVAS_SWITCHER_DIALOG_ID = "canvas-switcher";

/**
 * Dialog 打开期间自动刷新目录的间隔。
 *
 * 本机宿主的 GET /api/canvases 每次都会现查远端来源，因此 force load 就等于重新拉一次
 * 远端列表；不需要为新后端接口。打开切换器时每 15 秒静默重取，用户新建/删除画布后
 * 列表能自己跟上，不必手动关开弹窗。
 */
export const CATALOG_AUTO_REFRESH_MS = 15_000;

/** 「N 秒前更新」文案的推进粒度（只影响相对时间展示，不触发请求）。 */
const CATALOG_REFRESH_TICK_MS = 1_000;

/** 只读打开，不带业务 payload。 */
export const canvasSwitcherDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "md",
  variant: "standard",
  validatePayload: (payload) =>
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? { ok: true, payload: payload as Record<string, never> }
      : { ok: false, error: "画布切换器 payload 必须是对象" }
};

/** 相对时间：列表里只回答「多久没动过」，不摆绝对时间戳。 */
function formatRelativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const delta = Math.max(0, now - at);
  const minute = 60_000;
  if (delta < minute) return "刚刚更新";
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`;
  if (delta < 30 * 24 * 60 * minute) return `${Math.floor(delta / (24 * 60 * minute))} 天前`;
  return new Date(at).toLocaleDateString();
}

/** 条目副行：更新时间 + 规模。remote-only 的计数来自远端摘要，缺失时按 0 展示。 */
function itemMeta(entry: CanvasSummary): string {
  const updated = formatRelativeTime(entry.updatedAt);
  const scale = [
    entry.nodeCount > 0 ? `${entry.nodeCount} 个节点` : null,
    entry.assetCount > 0 ? `${entry.assetCount} 个素材` : null
  ].filter((part): part is string => part !== null);
  return [updated, ...scale].filter((part) => part !== "").join(" · ") || "暂无内容";
}

/** 目录同步状态的展示文案（触发器与条目徽标共用）。 */
const SYNC_LABELS: Record<NonNullable<CanvasSummary["sync"]>, string> = {
  "local-only": "仅本机",
  synced: "已同步",
  syncing: "同步中",
  offline: "离线",
  failed: "同步失败",
  "remote-only": "仅远端",
  // 属于远端、但本机还没有上游链路：改动只落在本机，必须显式说出来。
  unlinked: "未连接"
};

/**
 * 顶栏胶囊的**实时**连接态，来自当前画布会话而不是目录快照。
 *
 * 目录快照（`CanvasSummary.sync`）回答「本机↔远端存储同步到哪一步」，可能已经过期；
 * 断线时它仍会写着「已同步」，与右下角同步气泡的「只读」互相矛盾。因此胶囊以会话为准：
 * - `offline`：画布连接已断开，页面只读（文案「离线只读」）；
 * - `connecting`：会话仍在建连、尚未 ready（文案「连接中」）；
 * - `ready`：连接正常，胶囊回落目录同步标签（已同步/同步中/仅本机/…）。
 */
export type CanvasLiveSync = "offline" | "connecting" | "ready";

/** 实时态在胶囊里的短文案。 */
const LIVE_SYNC_LABELS: Record<Exclude<CanvasLiveSync, "ready">, string> = {
  offline: "离线只读",
  connecting: "连接中"
};

/** 实时态的详细说明（Tooltip 与 aria-label 用）：与右下角气泡回答同一件事。 */
const LIVE_SYNC_DETAILS: Record<Exclude<CanvasLiveSync, "ready">, string> = {
  offline: "画布连接已断开，只读，可在右下角重新连接",
  connecting: "正在连接画布服务"
};

/**
 * 实时态对应的 `data-sync` 相位：离线沿用离线色，连接中沿用同步中色，
 * 复用既有样式分支，不为实时态新增一套配色。
 */
const LIVE_SYNC_PHASES: Record<Exclude<CanvasLiveSync, "ready">, NonNullable<CanvasSummary["sync"]>> = {
  offline: "offline",
  connecting: "syncing"
};

/** 未注入实时态时的稳定空实现（useSyncExternalStore 需要稳定的 getSnapshot）。 */
const NO_LIVE_SYNC = () => undefined;

/** 顶层触发器：显示当前画布标题与同步状态，点击打开切换器。模型聚焦时隐藏。 */
export function CanvasSwitcherTrigger({
  getTitle,
  getSync,
  getLiveSync = NO_LIVE_SYNC,
  subscribeTitle,
  onOpen,
  onRefreshCatalog,
  navigation
}: {
  getTitle: () => string;
  getSync: () => CanvasSummary["sync"] | undefined;
  /**
   * 实时连接态（可选）。未注入时只看目录快照：断线/建连期间必须以它为准，
   * 否则胶囊会和右下角气泡说两套话。
   */
  getLiveSync?: () => CanvasLiveSync | undefined;
  subscribeTitle: (listener: () => void) => () => void;
  onOpen: () => void;
  onRefreshCatalog?: () => void;
  navigation: CanvasNavigationService;
}) {
  const title = useSyncExternalStore(subscribeTitle, getTitle, getTitle);
  const sync = useSyncExternalStore(subscribeTitle, getSync, getSync);
  const liveSync = useSyncExternalStore(subscribeTitle, getLiveSync, getLiveSync);
  const presentation = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  // 媒体补传期间目录不会自己刷新：触发器可见时短轮询，直到状态离开「同步中」。
  useEffect(() => {
    if (sync !== "syncing" || !onRefreshCatalog) return;
    const timer = setInterval(onRefreshCatalog, 1500);
    return () => clearInterval(timer);
  }, [sync, onRefreshCatalog]);
  if (presentation.mode.type === "node-focus") return null;
  const label = title.trim() || "未命名画布";
  // 实时态优先：断线/建连时不再显示目录快照的「已同步」，胶囊只表达一个事实。
  const livePhase = liveSync === "offline" || liveSync === "connecting" ? liveSync : null;
  const pillLabel = livePhase ? LIVE_SYNC_LABELS[livePhase] : sync ? SYNC_LABELS[sync] : null;
  const pillPhase: CanvasSummary["sync"] | undefined = livePhase ? LIVE_SYNC_PHASES[livePhase] : sync;
  const statusText = livePhase ? LIVE_SYNC_DETAILS[livePhase] : sync ? SYNC_LABELS[sync] : null;
  return (
    <Tooltip content={`当前画布：${label}${statusText ? ` · ${statusText}` : ""}`}>
      <Button
        className="canvas-switcher-trigger"
        tone="neutral"
        size="sm"
        aria-label={`当前画布：${label}${statusText ? `，${statusText}` : ""}，打开画布切换器`}
        data-testid="canvas-switcher-trigger"
        icon={<CanvasSwitcherIcon className="canvas-switcher-trigger__icon" />}
        onClick={onOpen}
      >
        <span className="canvas-switcher-trigger__title">{label}</span>
        {pillLabel && pillPhase ? (
          <span className="canvas-switcher-trigger__sync" data-sync={pillPhase} data-testid="canvas-switcher-sync">
            {pillLabel}
          </span>
        ) : null}
        <span className="canvas-switcher-trigger__caret" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </Button>
    </Tooltip>
  );
}

export type CanvasSwitcherDeps = {
  catalog: CanvasCatalogService;
  selection: CanvasSelectionService;
  session: CanvasSession;
  currentCanvasId: () => string;
  switchTo: (canvasId: string) => void;
  create: (options?: readonly CanvasCreateOptionContribution[]) => Promise<{ ok: boolean; error?: string; canvasId?: string }>;
  rename: (title: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Slot registry：条目右侧的扩展动作（`canvas.catalog-item-action`）从这里读取
   * （change: canvas 同步显式化）。宿主不做任何具体扩展判断。
   */
  slots: SlotsService;
  /**
   * 通用外部来源目录（可选；未注入时不显示来源分区）
   * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.7）。
   */
  sources?: {
    list: () => Promise<{ sourceId: string; displayName: string }[]>;
    listAccessible: (sourceId: string, cursor: string | null) => Promise<{ items: TemplateSourceItem[]; nextCursor: string | null }>;
  };
};

/** 来源作品条目（与平台 `SourceCanvasSummary` 对齐的最小展示字段）。 */
export type TemplateSourceItem = {
  ref: { sourceId: string; sourceCanvasId: string; cutoverGeneration: string };
  targetCanvasId: string;
  title: string;
  updatedAt: string;
  availability: "not-prepared" | "preparing" | "ready";
};

/**
 * 目录条目上的来源/同步徽标。
 *
 * 只表达**本机视角**的两个事实：这张画布在不在本机、同步到哪一步了。产物不做颜色
 * 语义（不是告警），因此一律用中性 badge，避免把"仅本机"渲染成一次错误。
 */
function SyncBadge({ entry }: { entry: CanvasSummary }) {
  const state = entry.sync;
  if (state === undefined) return null;
  return (
    <span className="canvas-switcher__source" data-sync={state}>
      {SYNC_LABELS[state]}
    </span>
  );
}

/** Dialog renderer：分页列表、新建、当前画布重命名与 busy/error 状态。 */
export function createCanvasSwitcherRenderer(deps: CanvasSwitcherDeps): DialogRenderer {
  return function CanvasSwitcherDialog({ instance, requestClose, setBusy }: DialogRendererProps) {
    const catalogState = useSyncExternalStore(deps.catalog.subscribe, deps.catalog.getState, deps.catalog.getState);
    const sessionStatus = useSyncExternalStore(deps.session.subscribe, deps.session.getStatus, deps.session.getStatus);
    // 条目动作 slot：订阅 slot 版本而不是打开时快照一次，保证扩展晚注册/注销后条目立刻跟上。
    useSyncExternalStore(
      (listener) => deps.slots.subscribe("canvas.catalog-item-action", listener),
      () => deps.slots.version(),
      () => deps.slots.version()
    );
const catalogItemActions = deps.slots.list("canvas.catalog-item-action");
    // 新建选项（`canvas.create-option`）：与条目动作同一套订阅方式，扩展晚注册也会出现。
    useSyncExternalStore(
      (listener) => deps.slots.subscribe("canvas.create-option", listener),
      () => deps.slots.version(),
      () => deps.slots.version()
    );
    const createOptions = deps.slots.list("canvas.create-option").filter((option) => option.available?.() !== false);
    const [selectedCreateOptions, setSelectedCreateOptions] = useState<string[]>(() =>
      createOptions.filter((option) => option.defaultEnabled === true).map((option) => option.id)
    );
    const currentCanvasId = deps.currentCanvasId();
    const currentEntry = catalogState.entries.find((entry) => entry.id === currentCanvasId);
    const [query, setQuery] = useState("");
    /** 重命名只在当前画布行内展开，不再常驻一个输入框占掉列表空间。 */
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(currentEntry?.title ?? "");
    const [busy, setLocalBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // —— 目录刷新状态（概览行的手动「刷新」+ Dialog 打开期间的自动刷新）——
    /** 一次刷新请求在飞行中：手动按钮与自动刷新据此互斥，不叠加请求。 */
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    /** 上一次**成功**刷新完成的时间：状态行只回答「多久前更新过」。 */
    const [lastRefreshedAt, setLastRefreshedAt] = useState(() => Date.now());
    /** 相对时间文案的时钟：每秒推进，不触发任何请求。 */
    const [clockNow, setClockNow] = useState(() => Date.now());
    const refreshingRef = useRef(false);
    /** 上一次 ready 快照：store 在失败分支会清空 entries，列表按旧快照继续展示。 */
    const lastReadyRef = useRef<{ entries: CanvasSummary[]; total: number } | null>(null);
    const writable = sessionStatus.remote.phase === "synced";
    const [sourceState, setSourceState] = useState<{
      status: "idle" | "loading" | "ready" | "error";
      sourceId: string | null;
      items: TemplateSourceItem[];
      nextCursor: string | null;
      loadingMore: boolean;
      error: string | null;
    }>({ status: "idle", sourceId: null, items: [], nextCursor: null, loadingMore: false, error: null });

    useEffect(() => {
      if (!deps.sources) return;
      let active = true;
      setSourceState((prev) => ({ ...prev, status: "loading", error: null }));
      void deps.sources.list().then(async (sources) => {
        if (!active) return;
        const source = sources.find((entry) => entry.displayName) ?? sources[0];
        if (!source) {
          setSourceState({ status: "ready", sourceId: null, items: [], nextCursor: null, loadingMore: false, error: null });
          return;
        }
        const page = await deps.sources!.listAccessible(source.sourceId, null);
        if (!active) return;
        setSourceState({ status: "ready", sourceId: source.sourceId, items: page.items, nextCursor: page.nextCursor, loadingMore: false, error: null });
      }).catch(() => {
        if (!active) return;
        setSourceState({ status: "error", sourceId: null, items: [], nextCursor: null, loadingMore: false, error: "来源目录不可用" });
      });
      return () => {
        active = false;
      };
    }, [deps.sources]);

    useEffect(() => {
      void deps.catalog.load();
    }, []);

    // 记住最后一次成功的目录快照：刷新失败时列表不该凭一条错误提示凭空消失。
    useEffect(() => {
      if (catalogState.status !== "ready") return;
      lastReadyRef.current = { entries: catalogState.entries, total: catalogState.total };
    }, [catalogState]);

    /**
     * 刷新一次目录：先失效缓存再强制重取（force → 本机宿主现查一次远端来源）。
     *
     * 与本地 busy / 加载更多 / 已在飞行中的刷新互斥，避免叠加请求；失败只记错误，
     * 不清空列表（列表兜底见 displayEntries）。
     */
    const refreshCatalogFromHeader = async () => {
      if (refreshingRef.current) return;
      if (busy || catalogState.loadingMore || catalogState.status === "loading") return;
      refreshingRef.current = true;
      setRefreshing(true);
      setRefreshError(null);
      try {
        deps.catalog.invalidate();
        const result = await deps.catalog.load(true);
        if (result.ok) setLastRefreshedAt(Date.now());
        else setRefreshError(result.error || "未知原因");
      } catch (caught) {
        setRefreshError(caught instanceof Error && caught.message ? caught.message : "未知原因");
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    };

    // 定时器回调只读 ref：状态行每秒更新一次，若把 refreshCatalogFromHeader 放进 deps，
    // 15 秒的节奏会被每秒的重渲染不断重置，永远等不到下一次自动刷新。
    const refreshRef = useRef(refreshCatalogFromHeader);
    useEffect(() => {
      refreshRef.current = refreshCatalogFromHeader;
    });

    // 自动刷新只在 Dialog 挂载期间生效；关闭（组件卸载）即清理定时器。
    useEffect(() => {
      const timer = setInterval(() => {
        void refreshRef.current();
      }, CATALOG_AUTO_REFRESH_MS);
      return () => clearInterval(timer);
    }, []);

    // 1s ticker 只推进「N 秒前更新」的相对文案，卸载时清理。
    useEffect(() => {
      const timer = setInterval(() => setClockNow(Date.now()), CATALOG_REFRESH_TICK_MS);
      return () => clearInterval(timer);
    }, []);

    // 条目顺序/标题变化时不偷偷覆盖用户正在编辑的值；只在离开编辑态时跟随权威标题。
    useEffect(() => {
      if (renaming) return;
      const entry = deps.catalog.getState().entries.find((item) => item.id === deps.currentCanvasId());
      if (entry) setRenameValue(entry.title);
    }, [catalogState.entries.length, renaming]);

    const run = async <T,>(action: () => Promise<T & { ok: boolean; error?: string }>): Promise<T | null> => {
      setLocalBusy(true);
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        if (!result.ok) setError(result.error ?? "操作失败");
        return result;
      } finally {
        setLocalBusy(false);
        setBusy(false);
      }
    };

    const onCreate = () => {
      // 勾选的选项按注册顺序交给宿主；建完画布后逐个 apply，失败不回滚画布。
      const chosen = createOptions.filter((option) => selectedCreateOptions.includes(option.id));
      // DialogHost rejects closing a busy instance; clear busy before requesting close.
      void run(() => deps.create(chosen)).then((result) => {
        if (result?.ok && result.canvasId) requestClose();
      });
    };

    const startRename = () => {
      setRenameValue(currentEntry?.title ?? "");
      setRenaming(true);
    };


    const onRename = () => {
      void run(async () => {
        const result = await deps.rename(renameValue);
        if (result.ok) setRenaming(false);
        return result;
      });
    };

    // 条目动作完成后刷新目录：先失效缓存再强制重取，使来源与同步徽标反映动作结果。
    const refreshCatalog = async () => {
      deps.catalog.invalidate();
      await deps.catalog.load(true);
    };

    // 刷新失败时 store 会清空 entries：这里退回上一次成功的快照，列表不因刷新失败消失。
    const staleSnapshot = catalogState.status === "error" ? lastReadyRef.current : null;
    const displayEntries = staleSnapshot ? staleSnapshot.entries : catalogState.entries;
    const displayTotal = staleSnapshot ? staleSnapshot.total : catalogState.total;
    const hasMore = catalogState.offset + displayEntries.length < displayTotal;
    const isOffline = sessionStatus.remote.phase === "offline";
    const hasSources = deps.sources !== undefined;
    // 搜索在列表真的开始变长时才出现：三张画布不需要一个搜索框。
    const canSearch = displayTotal > 5 || displayEntries.length > 5;
    const normalizedQuery = query.trim().toLowerCase();
    const visibleEntries = normalizedQuery === ""
      ? displayEntries
      : displayEntries.filter((entry) => (entry.title.trim() || "未命名画布").toLowerCase().includes(normalizedQuery));
    const isEmpty = catalogState.status === "ready" && catalogState.entries.length === 0;
    const isFilteredEmpty = normalizedQuery !== "" && visibleEntries.length === 0;
    const showSources = hasSources && (sourceState.error !== null || sourceState.items.length > 0);

    // 概览行的刷新状态：一次只表达一个事实（进行中 / 失败 / 自动刷新 + 相对时间）。
    const secondsSinceRefresh = Math.max(0, Math.floor((clockNow - lastRefreshedAt) / 1000));
    const refreshStatus = refreshing ? "refreshing" : refreshError !== null ? "error" : "auto";
    const refreshStatusText = refreshing
      ? "正在刷新…"
      : refreshError !== null
        ? `刷新失败：${refreshError}`
        : `自动刷新 · ${secondsSinceRefresh <= 0 ? "刚刚更新" : `${secondsSinceRefresh} 秒前更新`}`;

    const loadMoreSources = async () => {
      if (!deps.sources || !sourceState.sourceId || !sourceState.nextCursor || sourceState.loadingMore) return;
      setSourceState((prev) => ({ ...prev, loadingMore: true }));
      try {
        const page = await deps.sources.listAccessible(sourceState.sourceId, sourceState.nextCursor);
        setSourceState((prev) => ({ ...prev, items: [...prev.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false }));
      } catch {
        setSourceState((prev) => ({ ...prev, loadingMore: false, error: "来源目录不可用" }));
      }
    };

    /**
     * 新建选项行：单行紧凑形态（复选框 + 文案 + 灰色说明），可直接放进 footer 左侧。
     *
     * 之前做成「标题一行、说明一行」的独立块，视觉上像页脚外面漂着一段不属于任何人的
     * 表单；收进 footer 并与按钮同基线，才读得出「这是新建的前置选择」。
     */
    const renderCreateOptions = (variant: "footer" | "empty" = "footer") => {
      if (createOptions.length === 0) return null;
      const toggle = (id: string, checked: boolean) =>
        setSelectedCreateOptions((previous) =>
          checked ? [...previous, id] : previous.filter((item) => item !== id)
        );
      return (
        <div
          className={
            variant === "empty"
              ? "canvas-switcher__create-options canvas-switcher__create-options--center"
              : "canvas-switcher__create-options"
          }
        >
          {createOptions.map((option) => (
            <label key={option.id} className="canvas-switcher__create-option" title={option.description}>
              <input
                type="checkbox"
                checked={selectedCreateOptions.includes(option.id)}
                disabled={busy}
                onChange={(event) => toggle(option.id, event.target.checked)}
              />
              <span className="canvas-switcher__create-option-label">{option.label}</span>
              {option.description ? (
                <span className="canvas-switcher__create-option-hint">{option.description}</span>
              ) : null}
            </label>
          ))}
        </div>
      );
    };

    return (
      <Dialog.Content
        size="lg"
        variant="standard"
        labelledBy={`${CANVAS_SWITCHER_DIALOG_ID}-title`}
        busy={busy}
        instanceId={instance.instanceId}
        onOverlayClick={requestClose}
      >
        <Dialog.Header onClose={requestClose}>
          <Dialog.Title id={`${CANVAS_SWITCHER_DIALOG_ID}-title`}>画布</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <Dialog.Section className="canvas-switcher__overview">
            <div className="canvas-switcher__overview-row">
              <span className="canvas-switcher__count" data-testid="canvas-switcher-count">
                {normalizedQuery === ""
                  ? `${displayTotal} 张画布`
                  : `${visibleEntries.length} 张匹配 · 共 ${displayTotal} 张`}
              </span>
              {isOffline ? <span className="canvas-switcher__hint">离线只读：暂不可重命名</span> : null}
              {catalogState.loadingMore ? <span className="canvas-switcher__hint">正在加载更多…</span> : null}
              {/* 刷新入口靠右；列表本身是这台弹窗的主体，刷新只是附属动作。 */}
              <span className="canvas-switcher__refresh" data-state={refreshStatus}>
                <span
                  className="canvas-switcher__hint"
                  data-testid="canvas-switcher-refresh-status"
                  role="status"
                >
                  {refreshStatusText}
                </span>
                {/* 弹窗内的控件不包 Tooltip：Radix tooltip 会成为最高层 dismissable layer，
                    抢走 Escape（见 DialogIconButton 的同类取舍），这里用原生 title。 */}
                <Button
                  size="sm"
                  className="canvas-switcher__refresh-button"
                  data-testid="canvas-switcher-refresh"
                  title={`刷新画布列表（打开期间每 ${CATALOG_AUTO_REFRESH_MS / 1000} 秒自动刷新）`}
                  loading={refreshing}
                  disabled={refreshing || busy}
                  onClick={() => {
                    void refreshCatalogFromHeader();
                  }}
                >
                  {refreshing ? "刷新中…" : "刷新"}
                </Button>
              </span>
            </div>
            {canSearch ? (
              <div className="canvas-switcher__search">
                <SearchIcon className="canvas-switcher__search-icon" />
                <input
                  className="canvas-switcher__search-input"
                  type="search"
                  value={query}
                  placeholder="搜索画布标题"
                  aria-label="搜索画布"
                  disabled={busy}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query !== "") {
                      // 先清搜索，不要把整个弹窗关掉。
                      event.preventDefault();
                      event.stopPropagation();
                      setQuery("");
                      return;
                    }
                    if (event.key === "Enter" && visibleEntries.length === 1) {
                      event.preventDefault();
                      deps.switchTo(visibleEntries[0].id);
                      requestClose();
                    }
                  }}
                />
                {query !== "" ? (
                  <button
                    type="button"
                    className="canvas-switcher__search-clear"
                    aria-label="清除搜索"
                    onClick={() => setQuery("")}
                  >
                    <CloseIcon />
                  </button>
                ) : null}
              </div>
            ) : null}
          </Dialog.Section>

          <Dialog.Section className="canvas-switcher__list-section">
            {catalogState.status === "loading" && catalogState.entries.length === 0 ? (
              <p className="canvas-switcher__status" role="status">正在加载画布…</p>
            ) : null}
            {/* 刷新失败的原因已经写在概览行的状态里，这里不重复第二条同样的文案。 */}
            {catalogState.status === "error" && refreshError === null ? (
              <p className="canvas-switcher__error" role="status">{catalogState.error}</p>
            ) : null}
            {catalogState.status === "ready" && catalogState.entries.length === 0 ? (
              <p className="canvas-switcher__status">暂无画布</p>
            ) : null}
            {isEmpty ? (
              <div className="canvas-switcher__empty" data-testid="canvas-switcher-empty">
                <CanvasSwitcherIcon className="canvas-switcher__empty-icon" />
                <p className="canvas-switcher__empty-title">还没有画布</p>
                <p className="canvas-switcher__empty-hint">新建一张画布开始创作。</p>
            {renderCreateOptions("empty")}
                <Button tone="primary" onClick={onCreate} disabled={busy}>
                  新建画布
                </Button>
              </div>
            ) : null}
            {isFilteredEmpty ? (
              <p className="canvas-switcher__status">没有匹配「{query.trim()}」的画布</p>
            ) : null}
            <ScrollArea className="canvas-switcher__scroll" label="画布列表">
              <ul className="canvas-switcher__list" role="list">
                {visibleEntries.map((entry) => {
                  const isCurrent = entry.id === currentCanvasId;
                  return (
                    <li key={entry.id} className="canvas-switcher__item" data-current={isCurrent ? "true" : undefined}>
                      {/* 整行是一颗切换按钮；扩展动作是它的**兄弟**容器，动作按钮不能嵌在
                          <button> 里。点击动作只停在自己的容器内，不会触发行切换。 */}
                      {isCurrent && renaming ? (
                        <div className="canvas-switcher__rename-row canvas-switcher__rename-row--inline">
                          <input
                            className="canvas-switcher__input"
                            value={renameValue}
                            autoFocus
                            aria-label="当前画布标题"
                            disabled={!writable || busy}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && writable && !busy) {
                                event.preventDefault();
                                onRename();
                              }

                            }}
                          />
                          <Button size="sm" tone="primary" onClick={onRename} disabled={!writable || busy}>
                            保存
                          </Button>
                          <Button size="sm" onClick={() => setRenaming(false)} disabled={busy}>
                            取消
                          </Button>
                        </div>
                      ) : (
                      <div className="canvas-switcher__item-row">
                        <button
                          type="button"
                          className="canvas-switcher__item-button"
                          aria-current={isCurrent ? "true" : undefined}
                          onClick={() => {
                            if (isCurrent) {
                              requestClose();
                              return;
                            }
                            deps.switchTo(entry.id);
                            requestClose();
                          }}
                        >
                          <span className="canvas-switcher__item-main">
                            <span className="canvas-switcher__item-title">{entry.title.trim() || "未命名画布"}</span>
                            <span className="canvas-switcher__item-meta">{itemMeta(entry)}</span>
                          </span>
                          {/* 来源与同步状态：目录可以同时接入本机与远端，用户要能看出
                              "这张只在远端"（点开会从远端拉下来）与"还没同步上去"。 */}
                          <span className="canvas-switcher__item-badges">
                            {isCurrent ? <span className="canvas-switcher__badge">当前</span> : null}
                            <SyncBadge entry={entry} />
                          </span>
                        </button>
                        {isCurrent ? (
                          <button
                            type="button"
                            className="canvas-switcher__item-rename"
                            onClick={startRename}
                            disabled={!writable || busy}
                            title={writable ? "重命名当前画布" : "离线只读：暂不可重命名"}
                          >
                            重命名
                          </button>
                        ) : null}
                        {catalogItemActions.length > 0 ? (
                          <div
                            className="canvas-switcher__item-actions"
                            // 结构上已与行按钮并列；再阻止一次冒泡，避免以后给行容器加点击处理时
                            // 动作误触发行切换。
                            onClick={(event) => event.stopPropagation()}
                          >
                            {catalogItemActions.map((contribution) => {
                              const Action = contribution.render;
                              return (
                                <ContributionBoundary key={contribution.id} entry={contribution} slot="canvas.catalog-item-action">
                                  <Action
                                    entry={entry}
                                    openCanvas={deps.switchTo}
                                    refreshCatalog={refreshCatalog}
                                  />
                                </ContributionBoundary>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
            {hasMore ? (
              <Button
                disabled={catalogState.loadingMore || busy}
                onClick={() => void deps.catalog.loadMore()}
              >
                {catalogState.loadingMore ? "加载中…" : "加载更多"}
              </Button>
            ) : null}
          </Dialog.Section>
          {showSources ? (
            <Dialog.Section className="canvas-switcher__sources" data-testid="canvas-switcher-sources">
              <h3 className="canvas-switcher__section-title">历史来源</h3>
              {sourceState.status === "error" ? (
                <p className="canvas-switcher__error" role="status">{sourceState.error}</p>
              ) : null}
              {sourceState.items.length > 0 ? (
                <ul className="canvas-switcher__list" role="list" aria-label="历史来源作品">
                  {sourceState.items.map((item) => (
                    <li key={item.targetCanvasId} className="canvas-switcher__item">
                      <button
                        type="button"
                        className="canvas-switcher__item-button"
                        onClick={() => {
                          deps.switchTo(item.targetCanvasId);
                          requestClose();
                        }}
                      >
                        <span className="canvas-switcher__item-title">{item.title.trim() || item.targetCanvasId}</span>
                        <span className="canvas-switcher__source-badge" data-availability={item.availability}>
                          {item.availability === "ready" ? "已就绪" : item.availability === "preparing" ? "准备中" : "未准备"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {sourceState.nextCursor ? (
                <Button disabled={sourceState.loadingMore} onClick={() => void loadMoreSources()}>
                  {sourceState.loadingMore ? "加载中…" : "加载更多来源"}
                </Button>
              ) : null}
            </Dialog.Section>
          ) : null}
          <ScenePackageImport openCanvas={(id) => { requestClose(); deps.switchTo(id); }} />
          {error ? <p className="canvas-switcher__error" role="status">{error}</p> : null}
        </Dialog.Body>
        <Dialog.Footer>
          {renderCreateOptions()}
          <Button tone="primary" onClick={onCreate} disabled={busy}>
            新建画布
          </Button>
          <Button onClick={requestClose} disabled={busy}>
            关闭
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    );
  };
}
