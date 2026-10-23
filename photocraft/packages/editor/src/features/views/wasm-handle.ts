import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";
import {
  decodeGuideDrag,
  decodeGuideHit,
  decodeLengthFormat,
  decodeMeasurementLog,
  decodeProbe,
  decodeRulerOriginDrag,
  decodeSamplerReadout,
  decodeViewSnapshot,
  type GuideHitView,
  type ProbeReading,
  type ViewSnapshot,
} from "./decode.js";

/**
 * 本域的 wasm 端口适配（U70–U73）。
 *
 * ## 为什么返回 `unknown` 而不是强类型
 *
 * 共享 facade `EditorHandle.viewAids/setViewAids` 的既有契约就是 `unknown`；这里擅自改成强类型
 * 会让同一个方法对宿主暴露两种形状，也会让精简宿主/测试替身的子集响应直接变成失败。有界解码在
 * 显示边界（[`decodeViewAids`] 与面板）完成。
 *
 * ## 旧运行时/精简宿主
 *
 * U71–U73 的端口在旧 `.wasm` 与精简替身上可能不存在（见 [`FeatureEditorInstance`]）。这类缺失
 * 按 **能力关闭** 处理：返回 `capability-disabled` 让界面说明原因，而不是抛
 * `undefined is not a function` 或在有数据时伪造成功。
 */
function missing(port: string): EditorResult<never> {
  return {
    ok: false,
    code: "capability-disabled",
    message: `当前内核不提供 ${port}，请刷新或更新编辑内核`,
  };
}

export function viewAids(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.viewAidsJson()));
}

export function setViewAids(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.setViewAids(JSON.stringify(params))));
}

export function snapPoint(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.snapPoint(JSON.stringify(params))));
}

export function guideCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.guideCommand(id, JSON.stringify(params))));
}

/** 参考线布局与画布参考线（U71）；只接受本域声明的三条布局命令。 */
export function guideLayoutCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  const { instance } = this;
  if (typeof instance.guideLayoutCommand !== "function") return missing("参考线布局命令");
  return this.call((i) => JSON.parse(i.guideLayoutCommand!(id, JSON.stringify(params))));
}

/** 本域统一写入口：逐项白名单命令（取样、测量、计数、注释）。 */
export function viewCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  const { instance } = this;
  if (typeof instance.viewCommand !== "function") return missing("视图/分析命令");
  return this.call((i) => JSON.parse(i.viewCommand!(id, JSON.stringify(params))));
}

export function viewSnapshot(this: FeatureHandleContext): EditorResult<ViewSnapshot> {
  const { instance } = this;
  if (typeof instance.viewSnapshotJson !== "function") return missing("视图快照");
  return this.call((i) => {
    const value = decodeViewSnapshot(JSON.parse(i.viewSnapshotJson!()));
    if (!value) throw new Error("视图快照无效");
    return value;
  });
}

export function samplerReadout(this: FeatureHandleContext, index: number): EditorResult<ReturnType<typeof decodeSamplerReadout>> {
  const { instance } = this;
  if (typeof instance.samplerReadoutJson !== "function") return missing("取样点读数");
  return this.call((i) => {
    const value = decodeSamplerReadout(JSON.parse(i.samplerReadoutJson!(index)));
    if (!value) throw new Error("取样点读数无效");
    return value;
  });
}

export function formatLength(this: FeatureHandleContext, px: number, unit: string): EditorResult<{ text: string; unit: string }> {
  const { instance } = this;
  if (typeof instance.formatLengthJson !== "function") return missing("长度格式化");
  return this.call((i) => {
    const value = decodeLengthFormat(JSON.parse(i.formatLengthJson!(JSON.stringify({ px, unit }))));
    if (!value) throw new Error("长度读数无效");
    return value;
  });
}

export function measurementLog(this: FeatureHandleContext): EditorResult<ReturnType<typeof decodeMeasurementLog>> {
  const { instance } = this;
  if (typeof instance.viewCommand !== "function") return missing("测量日志");
  return this.call((i) => {
    const value = decodeMeasurementLog(JSON.parse(i.viewCommand!("measurementLog.list", "{}")));
    if (!value) throw new Error("测量日志无效");
    return value;
  });
}

/** 本域允许的画布指针动作；界面/画布只能从这里挑，不能拼任意字符串送给内核。 */
export const VIEW_POINTER_ACTIONS = ["hit-guide", "drag-guide", "drag-origin", "probe"] as const;
export type ViewPointerAction = (typeof VIEW_POINTER_ACTIONS)[number];

/**
 * 画布指针几何（U70–U73）：命中参考线、拖动参考线、拖动标尺原点、Info 源像素读数。
 *
 * 只读端口：命中不影响文档，拖动返回候选位置供界面作为草稿显示，提交时仍走
 * `view.moveGuide` / `view.setRulerOrigin`；`probe` 只读一个合成像素。旋转与缩放全部在内核的
 * 同一份变换里换算，界面不复制第二套坐标数学。
 */
export function viewPointer(
  this: FeatureHandleContext,
  action: ViewPointerAction,
  client: readonly [number, number],
  // `viewId` 是来源视图：多视图下只有活动视图能接收输入，内核据此拒绝后台视图的迟到指针。
  extra: { vertical?: boolean; tolerance?: number; viewId?: string } = {},
): EditorResult<
  | { kind: "hit"; locked: boolean; hit: GuideHitView | null }
  | { kind: "drag"; vertical: boolean; position: number | null; locked: boolean }
  | { kind: "origin"; origin: [number, number] | null; current: [number, number] }
  | { kind: "probe"; probe: ProbeReading }
> {
  const { instance } = this;
  if (typeof instance.viewPointerJson !== "function") return missing("画布指针几何");
  if (!VIEW_POINTER_ACTIONS.includes(action)) {
    return { ok: false, code: "capability-disabled", message: `${action} 不是已开放的指针几何动作` };
  }
  return this.call((i) => {
    const raw = JSON.parse(
      i.viewPointerJson!(action, JSON.stringify({ client: [client[0], client[1]], ...extra })),
    );
    if (action === "hit-guide") {
      const value = decodeGuideHit(raw);
      if (!value) throw new Error("参考线命中结果无效");
      return { kind: "hit" as const, locked: value.locked, hit: value.hit };
    }
    if (action === "drag-guide") {
      const value = decodeGuideDrag(raw);
      if (!value) throw new Error("参考线拖动结果无效");
      return { kind: "drag" as const, vertical: value.vertical, position: value.position, locked: value.locked };
    }
    if (action === "probe") {
      const value = decodeProbe(raw);
      if (!value) throw new Error("源像素读数无效");
      return { kind: "probe" as const, probe: value };
    }
    const value = decodeRulerOriginDrag(raw);
    if (!value) throw new Error("标尺原点拖动结果无效");
    return { kind: "origin" as const, origin: value.origin, current: value.current };
  });
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    viewAids: (...args: Parameters<OmitThisParameter<typeof viewAids>>) => viewAids.apply(context(), args),
    setViewAids: (...args: Parameters<OmitThisParameter<typeof setViewAids>>) => setViewAids.apply(context(), args),
    snapPoint: (...args: Parameters<OmitThisParameter<typeof snapPoint>>) => snapPoint.apply(context(), args),
    guideCommand: (...args: Parameters<OmitThisParameter<typeof guideCommand>>) => guideCommand.apply(context(), args),
    guideLayoutCommand: (...args: Parameters<OmitThisParameter<typeof guideLayoutCommand>>) => guideLayoutCommand.apply(context(), args),
    viewCommand: (...args: Parameters<OmitThisParameter<typeof viewCommand>>) => viewCommand.apply(context(), args),
    viewSnapshot: (...args: Parameters<OmitThisParameter<typeof viewSnapshot>>) => viewSnapshot.apply(context(), args),
    samplerReadout: (...args: Parameters<OmitThisParameter<typeof samplerReadout>>) => samplerReadout.apply(context(), args),
    formatLength: (...args: Parameters<OmitThisParameter<typeof formatLength>>) => formatLength.apply(context(), args),
    measurementLog: (...args: Parameters<OmitThisParameter<typeof measurementLog>>) => measurementLog.apply(context(), args),
    viewPointer: (...args: Parameters<OmitThisParameter<typeof viewPointer>>) => viewPointer.apply(context(), args),
  };
}
