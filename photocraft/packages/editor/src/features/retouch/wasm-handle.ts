import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

/**
 * 修饰域的 WASM 适配（change: 2026-10-22-add-photocraft-retouch-workflows）。
 *
 * 只做参数/结果编解码；门禁与事务在 `workspace.ts`（共用同一活动草稿边界）与 Rust 内核里。
 *
 * 区域与历史源这几个导出是本 change 新加的 glue 端口：宿主或旧产物可能还没有它们。缺失时
 * 返回 `missing-port` 失败，界面显示「当前宿主未接通」——**不**回退成普通画笔，也不假装成功。
 */

const MISSING = (port: string) => ({
  ok: false as const,
  code: "missing-port",
  message: `当前运行时不支持${port}（修饰端口未接通）`
});

export function beginRetouch(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.beginRetouch(id, JSON.stringify(params))));
  }

export function appendRetouch(this: FeatureHandleContext, points: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.appendRetouch(JSON.stringify({ points }))));
  }

export function commitRetouch(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.commitRetouch()));
  }

export function cancelRetouch(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.cancelRetouch()));
  }

/** 区域修饰开始：算出候选（不改正式文档）。 */
export function beginRetouchRegion(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    if (typeof this.instance.beginRetouchRegion !== "function") return MISSING("区域修饰");
    return this.call((i) => JSON.parse(i.beginRetouchRegion!(id, JSON.stringify(params))));
  }

/** 确认区域修饰：一步历史。 */
export function commitRetouchRegion(this: FeatureHandleContext, ): EditorResult<unknown> {
    if (typeof this.instance.commitRetouchRegion !== "function") return MISSING("区域修饰确认");
    return this.call((i) => JSON.parse(i.commitRetouchRegion!()));
  }

/** 取消区域修饰：丢弃候选。 */
export function cancelRetouchRegion(this: FeatureHandleContext, ): EditorResult<unknown> {
    if (typeof this.instance.cancelRetouchRegion !== "function") return MISSING("区域修饰取消");
    return this.call((i) => JSON.parse(i.cancelRetouchRegion!()));
  }

/** 仿制源槽位与叠加选项（只读；落笔期间也可查询，见 Rust `retouch_clone_sources`）。 */
export function retouchCloneSources(this: FeatureHandleContext): EditorResult<unknown> {
  if (typeof this.instance.retouchCloneSourcesJson !== "function") return MISSING("仿制源槽位");
  return this.call((i) => JSON.parse(i.retouchCloneSourcesJson!()));
}

/** 历史画笔可用的历史源（只读，不制造 dirty）。 */
export function retouchHistorySources(this: FeatureHandleContext, ): EditorResult<unknown> {
    if (typeof this.instance.retouchHistorySourcesJson !== "function") return MISSING("历史画笔源");
    return this.call((i) => JSON.parse(i.retouchHistorySourcesJson!()));
  }

export function createHandle(context: () => FeatureHandleContext) {
  return {
    beginRetouch: (...args: Parameters<OmitThisParameter<typeof beginRetouch>>) => beginRetouch.apply(context(), args),
    appendRetouch: (...args: Parameters<OmitThisParameter<typeof appendRetouch>>) => appendRetouch.apply(context(), args),
    commitRetouch: (...args: Parameters<OmitThisParameter<typeof commitRetouch>>) => commitRetouch.apply(context(), args),
    cancelRetouch: (...args: Parameters<OmitThisParameter<typeof cancelRetouch>>) => cancelRetouch.apply(context(), args),
    beginRetouchRegion: (...args: Parameters<OmitThisParameter<typeof beginRetouchRegion>>) => beginRetouchRegion.apply(context(), args),
    commitRetouchRegion: (...args: Parameters<OmitThisParameter<typeof commitRetouchRegion>>) => commitRetouchRegion.apply(context(), args),
    cancelRetouchRegion: (...args: Parameters<OmitThisParameter<typeof cancelRetouchRegion>>) => cancelRetouchRegion.apply(context(), args),
    retouchHistorySources: (...args: Parameters<OmitThisParameter<typeof retouchHistorySources>>) => retouchHistorySources.apply(context(), args),
    retouchCloneSources: (...args: Parameters<OmitThisParameter<typeof retouchCloneSources>>) => retouchCloneSources.apply(context(), args),
  };
}
