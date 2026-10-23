import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";
import {
  decodeFilterCatalogue,
  decodeFilterDraft,
  decodeFilterLast,
  decodeFilterLayerSources,
  decodeFilterMapSources,
  decodeFilterPathSources,
  decodeFilterStack,
  type FilterCatalogue,
  type FilterDraftInfo,
  type FilterLast,
  type FilterLayerSource,
  type FilterMapSource,
  type FilterPathSources,
  type FilterStackEffect
} from "./catalogue.js";

/**
 * 本域的 WASM 适配（U46–U49）。
 *
 * 草稿四步是 P6 起就有的端口；清单/上次滤镜/重复/控制点是本 change 新加的 glue 导出。
 * 后者在宿主或旧产物里可能还不存在：那时返回 `missing-port` 失败并给出可读原因，界面据此
 * 不渲染参数面板（清单缺失）或禁用对应按钮，**不**回退成硬编码参数、也不假装成功。
 */

const missing = (port: string) => ({
  ok: false as const,
  code: "missing-port",
  message: `当前运行时不支持${port}（滤镜端口未接通）`
});

export function beginFilter(this: FeatureHandleContext, id: string, params: unknown): EditorResult<FilterDraftInfo> {
  return this.call((i) => {
    const draft = decodeFilterDraft(JSON.parse(i.beginFilter(id, JSON.stringify(params ?? {}))));
    if (!draft) throw new Error("滤镜草稿响应无效");
    return draft;
  });
}

export function updateFilter(this: FeatureHandleContext, params: unknown): EditorResult<FilterDraftInfo> {
  return this.call((i) => {
    const draft = decodeFilterDraft(JSON.parse(i.updateFilter(JSON.stringify(params ?? {}))));
    if (!draft) throw new Error("滤镜草稿响应无效");
    return draft;
  });
}

export function commitFilter(this: FeatureHandleContext, ): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.commitFilter()));
}

export function cancelFilter(this: FeatureHandleContext, ): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.cancelFilter()));
}

/** 滤镜清单：解码失败的目录不可用，面板据此不渲染（而不是画出半套滑杆）。 */
export function filterCatalogue(this: FeatureHandleContext, ): EditorResult<FilterCatalogue> {
  if (typeof this.instance.filterCatalogueJson !== "function") return missing("滤镜清单");
  return this.call((i) => {
    const catalogue = decodeFilterCatalogue(JSON.parse(i.filterCatalogueJson!()));
    if (!catalogue) throw new Error("滤镜清单响应无效");
    return catalogue;
  });
}

export function filterGalleryDefaultStack(this: FeatureHandleContext, ): EditorResult<FilterStackEffect[]> {
  if (typeof this.instance.filterGalleryDefaultStackJson !== "function") return missing("滤镜库默认组合");
  return this.call((i) => {
    const stack = decodeFilterStack(JSON.parse(i.filterGalleryDefaultStackJson!()));
    if (!stack) throw new Error("滤镜库默认组合响应无效");
    return stack;
  });
}

export function filterDraftState(this: FeatureHandleContext, ): EditorResult<FilterDraftInfo | null> {
  if (typeof this.instance.filterDraftStateJson !== "function") return missing("滤镜草稿状态");
  return this.call((i) => {
    const raw = JSON.parse(i.filterDraftStateJson!()) as unknown;
    if (raw === null) return null;
    // 有响应但解不出来，说明内核与界面版本不匹配：明确失败，不静默当成「没有草稿」。
    const state = decodeFilterDraft(raw);
    if (!state) throw new Error("滤镜草稿状态响应无效");
    return state;
  });
}

export function filterLast(this: FeatureHandleContext, ): EditorResult<FilterLast> {
  if (typeof this.instance.filterLastJson !== "function") return missing("上次滤镜");
  return this.call((i) => {
    const last = decodeFilterLast(JSON.parse(i.filterLastJson!()));
    if (!last) throw new Error("上次滤镜响应无效");
    return last;
  });
}

/** 重复上次滤镜：内核重建草稿，本方法只解码回执（仍需显式确认）。 */
export function repeatLastFilter(this: FeatureHandleContext, ): EditorResult<FilterDraftInfo> {
  if (typeof this.instance.repeatLastFilter !== "function") return missing("重复上次滤镜");
  return this.call((i) => {
    const response = JSON.parse(i.repeatLastFilter!()) as unknown;
    const draft = typeof response === "object" && response !== null && "draft" in response
      ? decodeFilterDraft((response as { draft: unknown }).draft)
      : null;
    if (!draft) throw new Error("重复滤镜响应无效");
    return draft;
  });
}

/** 图内控制点：文档坐标 → 0–1 相对坐标。 */
export function filterNormalizePoint(this: FeatureHandleContext, x: number, y: number, width: number, height: number): EditorResult<[number, number]> {
  if (typeof this.instance.filterNormalizePoint !== "function") return missing("滤镜控制点换算");
  return this.call((i) => {
    const parsed = JSON.parse(i.filterNormalizePoint!(x, y, width, height)) as { point?: unknown };
    const point = parsed?.point;
    if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("控制点响应无效");
    }
    return [point[0] as number, point[1] as number];
  });
}

/** 位移图来源：会话里已打开的文档（置换滤镜只从文档取图）。 */
export function filterMapSources(this: FeatureHandleContext): EditorResult<FilterMapSource[]> {
  if (typeof this.instance.filterMapSourcesJson !== "function") return missing("位移图来源");
  return this.call((i) => {
    const sources = decodeFilterMapSources(JSON.parse(i.filterMapSourcesJson!()));
    if (!sources) throw new Error("位移图来源响应无效");
    return sources;
  });
}

/** 消失点粘贴的图层来源：内核 `paste[].layer` 只认图层 id，没有它就只剩剪贴板一条路。 */
export function filterLayerSources(this: FeatureHandleContext): EditorResult<FilterLayerSource[]> {
  if (typeof this.instance.filterLayerSourcesJson !== "function") return missing("粘贴图层来源");
  return this.call((i) => {
    const sources = decodeFilterLayerSources(JSON.parse(i.filterLayerSourcesJson!()));
    if (!sources) throw new Error("粘贴图层来源响应无效");
    return sources;
  });
}

/** 火焰滤镜的路径来源：`path` 是已保存路径的名字，不是坐标数组。 */
export function filterPathSources(this: FeatureHandleContext): EditorResult<FilterPathSources> {
  if (typeof this.instance.filterPathSourcesJson !== "function") return missing("火焰路径来源");
  return this.call((i) => {
    const sources = decodeFilterPathSources(JSON.parse(i.filterPathSourcesJson!()));
    if (!sources) throw new Error("火焰路径来源响应无效");
    return sources;
  });
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    beginFilter: (...args: Parameters<OmitThisParameter<typeof beginFilter>>) => beginFilter.apply(context(), args),
    updateFilter: (...args: Parameters<OmitThisParameter<typeof updateFilter>>) => updateFilter.apply(context(), args),
    commitFilter: (...args: Parameters<OmitThisParameter<typeof commitFilter>>) => commitFilter.apply(context(), args),
    cancelFilter: (...args: Parameters<OmitThisParameter<typeof cancelFilter>>) => cancelFilter.apply(context(), args),
    filterCatalogue: (...args: Parameters<OmitThisParameter<typeof filterCatalogue>>) => filterCatalogue.apply(context(), args),
    filterGalleryDefaultStack: (...args: Parameters<OmitThisParameter<typeof filterGalleryDefaultStack>>) => filterGalleryDefaultStack.apply(context(), args),
    filterDraftState: (...args: Parameters<OmitThisParameter<typeof filterDraftState>>) => filterDraftState.apply(context(), args),
    filterLast: (...args: Parameters<OmitThisParameter<typeof filterLast>>) => filterLast.apply(context(), args),
    repeatLastFilter: (...args: Parameters<OmitThisParameter<typeof repeatLastFilter>>) => repeatLastFilter.apply(context(), args),
    filterNormalizePoint: (...args: Parameters<OmitThisParameter<typeof filterNormalizePoint>>) => filterNormalizePoint.apply(context(), args),
    filterMapSources: (...args: Parameters<OmitThisParameter<typeof filterMapSources>>) => filterMapSources.apply(context(), args),
    filterLayerSources: (...args: Parameters<OmitThisParameter<typeof filterLayerSources>>) => filterLayerSources.apply(context(), args),
    filterPathSources: (...args: Parameters<OmitThisParameter<typeof filterPathSources>>) => filterPathSources.apply(context(), args),
  };
}
