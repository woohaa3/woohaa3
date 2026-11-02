/**
 * 资源栏「图片」条目展开后的图库面板。
 *
 * 版式照参考稿：顶部「所有图片 / 收藏的图片」切换 → 搜索 → 来源筛选 chip →
 * 按来源分组的两列网格 → 末尾「没有更多了」。
 *
 * 只依赖 {@link ImageLibrarySource}，不直接读画布：同一份数据也要给四喜的「资源」页用，
 * 日后从「当前画布」换成「跨画布」只换数据源。
 *
 * **「图库根目录」chip 没有做**：参考稿有，但宿主里没有对应概念（`external` 来源目前没有任何写入方），
 * 做出来只会是个永远为空的筛选。有外部来源的图时才会出现「外部导入」分组。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, CloseIcon, PlusIcon, SearchIcon, StarIcon } from "@woohaa3/ui/icons";
import {
  DEFAULT_IMAGE_FILTER,
  countByCanvas,
  countByOrigin,
  filterImages,
  type ImageFilter,
  type ImageLibraryItem,
  type ImageLibraryResult,
  type ImageLibrarySource,
  type ImageOrigin
} from "./image-library.js";
import type { ThumbnailLoader } from "./image-thumbnails.js";
import { createThumbnailLoader } from "./image-thumbnails.js";
import "./canvas-image-panel.css";

const GROUPS: ReadonlyArray<{ origin: ImageOrigin; label: string }> = [
  { origin: "uploaded", label: "画布上传" },
  { origin: "generated", label: "画布生成" },
  { origin: "external", label: "外部导入" }
];

export function CanvasImagePanel({
  source,
  currentCanvasId
}: {
  source: ImageLibrarySource;
  /** 当前打开的画布；跨画布数据源靠它把「当前画布」排在最前。 */
  currentCanvasId?: string;
}) {
  const items = useSyncExternalStore(source.subscribe, source.getItems, source.getItems);
  // 默认只看当前画布（与参考稿一致）；「全部画布」是主动选择
  const [filter, setFilter] = useState<ImageFilter>(() => ({
    ...DEFAULT_IMAGE_FILTER,
    canvasId: currentCanvasId ?? null
  }));
  const [failure, setFailure] = useState<string | null>(null);
  // 缩略图加载器：整个面板共用一份缓存，图多时也只有 3 张在同时解码
  const [thumbnails] = useState(() => createThumbnailLoader());
  /*
   * 缩略图加载器的 `dispose` 只作废在途结果、释放已缓存的 Blob URL，**不会**让实例失效
   * （StrictMode 会跑「执行 → 清理 → 执行」，永久关闭会让面板一张图都不出）。
   * 数据源的 `dispose` 则是真的退订，可以放心在卸载时调。
   */
  useEffect(
    () => () => {
      thumbnails.dispose();
      source.dispose?.();
    },
    [thumbnails, source]
  );
  // 只有跨画布数据源才有 refresh；单画布时不显示画布下拉
  const crossCanvas = typeof source.refresh === "function";
  const othersLoading = useSyncExternalStore(
    source.subscribe,
    () => source.loadingOthers === true,
    () => false
  );
  const othersFailure = useSyncExternalStore(
    source.subscribe,
    () => source.othersFailure ?? null,
    () => null
  );

  const counts = useMemo(() => countByOrigin(items, filter), [items, filter]);
  const visible = useMemo(() => filterImages(items, filter), [items, filter]);
  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: visible.filter((item) => item.origin === group.origin)
      })).filter((group) => group.items.length > 0),
    [visible]
  );

  const byCanvas = useMemo(
    () => countByCanvas(items, filter, currentCanvasId ?? null),
    [items, filter, currentCanvasId]
  );
  const currentCount = byCanvas.find((entry) => entry.canvasId === currentCanvasId)?.count ?? 0;
  const allCount = byCanvas.reduce((sum, entry) => sum + entry.count, 0);
  const patch = (next: Partial<ImageFilter>) => setFilter((current) => ({ ...current, ...next }));
  const pickCanvas = (canvasId: string | null) => {
    patch({ canvasId });
    /*
     * 只有切到别的画布 / 全部画布时才需要其他画布的数据。首次切过去要拉一次
     * （数据源默认不预取，见 `crossCanvasSource`）；后端有短缓存，来回切不会连发请求。
     */
    if (canvasId !== currentCanvasId && source.refresh) void source.refresh();
  };
  // 只有真有外部来源的图时才给 chip，否则就是个永远为空的筛选
  const chips = GROUPS.filter((group) => group.origin !== "external" || counts.external > 0);

  return (
    <section className="canvas-image-panel" aria-label="图片库" data-testid="canvas-image-panel">
      <div className="canvas-image-panel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={filter.tab === "all"}
          className={`canvas-image-panel__tab${filter.tab === "all" ? " is-active" : ""}`}
          onClick={() => patch({ tab: "all" })}
        >
          所有图片
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter.tab === "favorite"}
          className={`canvas-image-panel__tab${filter.tab === "favorite" ? " is-active" : ""}`}
          onClick={() => patch({ tab: "favorite" })}
        >
          收藏的图片
        </button>
      </div>

      <label className="canvas-image-panel__search">
        <SearchIcon size={14} />
        <input
          type="text"
          value={filter.query}
          placeholder="搜索"
          aria-label="搜索图片"
          onChange={(event) => patch({ query: event.target.value })}
        />
        {filter.query ? (
          <button type="button" aria-label="清除搜索" onClick={() => patch({ query: "" })}>
            <CloseIcon size={12} />
          </button>
        ) : null}
      </label>

      {/*
       * 画布下拉：跨画布数据源才有。默认「当前画布」，切到「全部画布」时才去拉其他画布 ——
       * 大多数时候用户只看自己正在做的这张，不该一打开就请求整份列表。
       */}
      {crossCanvas ? (
        <label className="canvas-image-panel__canvas">
          <span className="canvas-image-panel__canvas-label">画布</span>
          <select
            value={filter.canvasId ?? ""}
            aria-label="按画布筛选"
            onChange={(event) => pickCanvas(event.target.value === "" ? null : event.target.value)}
          >
            {/*
             * 顺序固定为：全部 → 当前画布 → 其余按数量。
             * 「当前画布」必须在最上方第二项：画布一多，名字又大多叫「未命名画布」，
             * 排到末尾就要滚到底才能找到。
             */}
            <option value="">全部画布（{allCount}）</option>
            {currentCanvasId ? (
              <option value={currentCanvasId}>当前画布（{currentCount}）</option>
            ) : null}
            {byCanvas
              .filter((entry) => entry.canvasId !== currentCanvasId)
              .map((entry) => (
                <option key={entry.canvasId} value={entry.canvasId}>
                  {entry.canvasTitle.trim() || "未命名画布"}（{entry.count}）
                </option>
              ))}
          </select>
          <ChevronDownIcon size={14} />
        </label>
      ) : null}

      <div className="canvas-image-panel__chips" role="group" aria-label="按来源筛选">
        {chips.map((group) => {
          const active = filter.origin === group.origin;
          return (
            <button
              key={group.origin}
              type="button"
              aria-pressed={active}
              className={`canvas-image-panel__chip${active ? " is-active" : ""}`}
              onClick={() => patch({ origin: active ? null : group.origin })}
            >
              {group.label}
            </button>
          );
        })}
      </div>

      <div className="canvas-image-panel__scroll">
        {grouped.length === 0 ? (
          <p className="canvas-image-panel__empty" role="status">
            {emptyText(items.length, filter)}
          </p>
        ) : (
          <>
            {grouped.map((group) => (
              <div key={group.origin} className="canvas-image-panel__group">
                <h3 className="canvas-image-panel__heading">
                  {group.label} · {group.items.length}
                </h3>
                <ul className="canvas-image-panel__grid">
                  {group.items.map((item) => (
                    <ImageTile
                      key={`${item.canvasId}:${item.id}`}
                      item={item}
                      source={source}
                      thumbnails={thumbnails}
                      onFailure={setFailure}
                    />
                  ))}
                </ul>
              </div>
            ))}
            <p className="canvas-image-panel__end">没有更多了</p>
          </>
        )}
      </div>
      {/*
       * 写失败（只读会话、找不到资产）要说出来：按钮点了没反应，用户只会反复点。
       * 成功不提示 —— 图块上的星标和画布上多出来的节点本身就是反馈。
       */}
      {crossCanvas && othersLoading ? (
        <p className="canvas-image-panel__scope" role="status">
          正在读取其他画布的图片…
        </p>
      ) : null}
      {crossCanvas && othersFailure && !othersLoading ? (
        <p className="canvas-image-panel__failure" role="alert">
          {othersFailure}
        </p>
      ) : null}
      {failure ? (
        <p className="canvas-image-panel__failure" role="alert">
          {failure}
        </p>
      ) : null}
      <p className="canvas-image-panel__scope">范围：{source.scopeLabel}</p>
    </section>
  );
}

/**
 * 图块：悬停/聚焦时浮出「收藏」与「添加到画布」两枚按钮（照参考稿）。
 *
 * 触屏与键盘用户看不到悬停态，所以按钮**始终在 DOM 里**、用 CSS 控制可见性，
 * `:focus-within` 时同样显示；读屏软件一直能读到（`aria-label`）。
 */
function ImageTile({
  item,
  source,
  thumbnails,
  onFailure
}: {
  item: ImageLibraryItem;
  source: ImageLibrarySource;
  thumbnails: ThumbnailLoader;
  onFailure: (reason: string | null) => void;
}) {
  const report = (result: ImageLibraryResult) => onFailure(result.ok ? null : result.reason);
  /*
   * 只渲染缩略图，**不**把原图塞进网格：图库里的原图实测最大 22MB，一张张整图解码是
   * 「图一多就卡」的直接原因。缩略图没就绪时先放占位，就绪后换图。
   */
  /*
   * `subscribe` 必须是稳定引用：内联箭头函数每次渲染都换新引用，React 会不停地重订阅、
   * 触发重渲染，`request` 反而一直排不上（实测：占位一直不消失，一张缩略图都不生成）。
   */
  const subscribe = useCallback(
    (listener: () => void) => thumbnails.subscribe(item.url, listener),
    [thumbnails, item.url]
  );
  const thumbnail = useSyncExternalStore(subscribe, () => thumbnails.get(item.url), () => null);
  useEffect(() => {
    thumbnails.request(item.url);
  }, [thumbnails, item.url]);

  return (
    <li className="canvas-image-panel__tile" title={item.title}>
      {thumbnail ? (
        <img src={thumbnail} alt={item.title} loading="lazy" draggable={false} />
      ) : (
        <span className="canvas-image-panel__skeleton" aria-hidden="true" />
      )}
      <div className="canvas-image-panel__actions">
        <button
          type="button"
          className={`canvas-image-panel__action${item.isFavorite ? " is-active" : ""}`}
          aria-label={item.isFavorite ? `取消收藏「${item.title}」` : `收藏「${item.title}」`}
          aria-pressed={item.isFavorite}
          title={item.isFavorite ? "取消收藏" : "收藏"}
          onClick={() => report(source.setFavorite(item.id, !item.isFavorite))}
        >
          <StarIcon size={14} fill={item.isFavorite ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          className="canvas-image-panel__action"
          aria-label={`添加到画布「${item.title}」`}
          title="添加到画布"
          onClick={() => {
            void source.addToCanvas(item.id).then(report);
          }}
        >
          <PlusIcon size={14} />
        </button>
      </div>
    </li>
  );
}

function emptyText(total: number, filter: ImageFilter): string {
  if (total === 0) return "这张画布里还没有图片";
  if (filter.query.trim()) return "没有匹配的图片";
  if (filter.tab === "favorite") return "还没有收藏的图片";
  return "没有符合条件的图片";
}
