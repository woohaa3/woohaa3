import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { FilterCatalogue, FilterDraftInfo, FilterLast, FilterLayerSource, FilterMapSource, FilterPathSources, FilterStackEffect } from "./catalogue.js";

/**
 * 滤镜域的会话副作用：活动草稿标记、写后同步与目录缓存。
 *
 * 真正的内核调用统一走 `handle.features.filters`（同一个域句柄），这样共享
 * `EditorHandle` 不需要为每个新命令再加一层转发方法。
 */

/** 目录是内核静态数据，一份句柄只取一次（面板每次渲染都会读它）。 */
let catalogueCache: { handle: unknown; value: FilterCatalogue } | null = null;

export function beginFilter(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<FilterDraftInfo> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
    const result = handle.features.filters.beginFilter(id, params);
    if (result.ok) this.filterActive = true;
    return result;
  }

export function updateFilter(this: WorkspaceFeatureContext, params: unknown): EditorResult<FilterDraftInfo> {
    if (this.handle === null || !this.filterActive) return this.unavailable();
    return this.handle.features.filters.updateFilter(params);
  }

export function commitFilter(this: WorkspaceFeatureContext, ): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle || !this.filterActive) return this.unavailable();
    const result = handle.features.filters.commitFilter();
    this.filterActive = false;
    if (!result.ok) { handle.features.filters.cancelFilter(); return this.fail(result); }
    return this.afterWrite();
  }

export function cancelFilter(this: WorkspaceFeatureContext, ): void {
    if (this.filterActive) this.handle?.features.filters.cancelFilter();
    this.filterActive = false;
  }

export function hasFilter(this: WorkspaceFeatureContext, ): boolean {
    return this.filterActive;
  }

/** 滤镜清单（分类、参数 schema、画廊目录与上限）。失败即不可用，面板不渲染半套滑杆。 */
export function filterCatalogue(this: WorkspaceFeatureContext, ): EditorResult<FilterCatalogue> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (catalogueCache && catalogueCache.handle === handle) return { ok: true, value: catalogueCache.value };
    const result = handle.features.filters.filterCatalogue();
    if (!result.ok) return result;
    catalogueCache = { handle, value: result.value };
    return result;
  }

/** 滤镜库目录与默认组合（Filter Gallery 首次打开即可预览）。 */
export function filterGalleryDefaultStack(this: WorkspaceFeatureContext, ): EditorResult<FilterStackEffect[]> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.filters.filterGalleryDefaultStack();
  }

/** 「重复上次」的可用性：无历史时返回原因，面板据此禁用按钮而不是点了才报错。 */
export function filterLast(this: WorkspaceFeatureContext, ): EditorResult<FilterLast> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.filters.filterLast();
  }

/**
 * 重复上次滤镜：内核用规范参数重建草稿（仍要显式确认）。
 *
 * 与 `beginFilter` 一样占用滤镜草稿通道，因此同样受「当前无其它草稿」门禁。
 */
export function repeatLastFilter(this: WorkspaceFeatureContext, ): EditorResult<FilterDraftInfo> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
    const result = handle.features.filters.repeatLastFilter();
    if (result.ok) this.filterActive = true;
    return result;
  }

/** 当前草稿状态（面板重挂载后恢复输入与「确认/取消」可用性）。 */
export function filterDraftState(this: WorkspaceFeatureContext, ): EditorResult<FilterDraftInfo | null> {
    const handle = this.handle;
    if (!handle || !this.filterActive) return { ok: true, value: null };
    return handle.features.filters.filterDraftState();
  }

/** 图内控制点：文档坐标 → 0–1 相对坐标（模糊画廊/消失点/广角约束共用）。 */
export function filterNormalizePoint(this: WorkspaceFeatureContext, x: number, y: number, width: number, height: number): EditorResult<[number, number]> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0) || !(height > 0)) {
      return { ok: false, code: "invalid-param", message: "控制点坐标无效" };
    }
    return handle.features.filters.filterNormalizePoint(x, y, width, height);
  }

/** 位移图来源：会话里已打开的文档（置换滤镜不从本机路径读图）。 */
export function filterMapSources(this: WorkspaceFeatureContext): EditorResult<FilterMapSource[]> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.filters.filterMapSources();
  }

/** 消失点粘贴的图层来源：当前文档里可见且带像素的图层（图层 id + 名称 + 尺寸）。 */
export function filterLayerSources(this: WorkspaceFeatureContext): EditorResult<FilterLayerSource[]> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.filters.filterLayerSources();
  }

/** 火焰滤镜的路径来源：已保存路径名 + 是否有工作路径。 */
export function filterPathSources(this: WorkspaceFeatureContext): EditorResult<FilterPathSources> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.filters.filterPathSources();
  }

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    beginFilter: (...args: Parameters<OmitThisParameter<typeof beginFilter>>) => beginFilter.apply(context(), args),
    updateFilter: (...args: Parameters<OmitThisParameter<typeof updateFilter>>) => updateFilter.apply(context(), args),
    commitFilter: (...args: Parameters<OmitThisParameter<typeof commitFilter>>) => commitFilter.apply(context(), args),
    cancelFilter: (...args: Parameters<OmitThisParameter<typeof cancelFilter>>) => cancelFilter.apply(context(), args),
    hasFilter: (...args: Parameters<OmitThisParameter<typeof hasFilter>>) => hasFilter.apply(context(), args),
    filterCatalogue: (...args: Parameters<OmitThisParameter<typeof filterCatalogue>>) => filterCatalogue.apply(context(), args),
    filterLast: (...args: Parameters<OmitThisParameter<typeof filterLast>>) => filterLast.apply(context(), args),
    repeatLastFilter: (...args: Parameters<OmitThisParameter<typeof repeatLastFilter>>) => repeatLastFilter.apply(context(), args),
    filterDraftState: (...args: Parameters<OmitThisParameter<typeof filterDraftState>>) => filterDraftState.apply(context(), args),
    filterNormalizePoint: (...args: Parameters<OmitThisParameter<typeof filterNormalizePoint>>) => filterNormalizePoint.apply(context(), args),
    filterMapSources: (...args: Parameters<OmitThisParameter<typeof filterMapSources>>) => filterMapSources.apply(context(), args),
    filterLayerSources: (...args: Parameters<OmitThisParameter<typeof filterLayerSources>>) => filterLayerSources.apply(context(), args),
    filterPathSources: (...args: Parameters<OmitThisParameter<typeof filterPathSources>>) => filterPathSources.apply(context(), args),
    filterGalleryDefaultStack: (...args: Parameters<OmitThisParameter<typeof filterGalleryDefaultStack>>) => filterGalleryDefaultStack.apply(context(), args),
  };
}
