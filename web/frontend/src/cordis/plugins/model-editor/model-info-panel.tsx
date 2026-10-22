/**
 * 模型聚焦信息面板
 * （change: 2026-10-18-simplify-model-focus-panel）。
 *
 * 普通 `model3d` 聚焦不再提供镜头、取景与截图，只展示**模型规模**（点数 / 面数 / 对象数）与
 * 内容状态，作为「这段模型由 AI 生成/修改」的只读上下文。数值来自已就绪的 prepared model
 * resource（历史浏览时来自本地 snapshot override），不重新执行脚本、不遍历渲染帧。
 *
 * 纯展示：不写 Store / Y.Doc，不发 CanvasCommand，也不查询 GPU 实测统计。
 */
import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  modelSceneStatistics,
  type ModelSceneStatistics,
  type SceneV2Op
} from "@woohaa3/contracts";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";

export type ModelInfoRow = { label: string; value: string };

export type ModelInfoSnapshot = {
  /** 内容是否已有可统计的 Scene IR。 */
  ready: boolean;
  /** 内容准备中（本地排队/编译）。 */
  loading: boolean;
  /** 脚本执行失败的安全信息（来自 canonical nodeData）。 */
  error: string | null;
  stats: ModelSceneStatistics | null;
  /** 面板展示的规模行（已格式化）。 */
  rows: ModelInfoRow[];
};

/** 千分位数字，避免大模型点数难以速读。 */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)).toLocaleString("en-US") : "0";
}

/** 由规模统计派生展示行（无内容时为空）。 */
export function modelInfoRows(stats: ModelSceneStatistics | null): ModelInfoRow[] {
  if (!stats) return [];
  const rows: ModelInfoRow[] = [
    { label: "对象", value: formatCount(stats.objects) },
    { label: "点数", value: formatCount(stats.vertices) },
    { label: "面数", value: formatCount(stats.triangles) }
  ];
  if (stats.groups > 0) rows.push({ label: "分组", value: formatCount(stats.groups) });
  if (stats.materials > 0) rows.push({ label: "材质", value: formatCount(stats.materials) });
  if (stats.animations > 0) rows.push({ label: "动画", value: formatCount(stats.animations) });
  return rows;
}

/**
 * 读取聚焦模型的规模快照。
 *
 * 优先使用历史浏览的本地 override（与主画面同源），其次是已就绪的 prepared resource；
 * 两者都缺失时报告 loading/error，绝不显示 0 冒充空模型。
 */
export function readModelInfo(input: {
  operations: readonly SceneV2Op[] | null;
  loading: boolean;
  error: string | null;
}): ModelInfoSnapshot {
  const stats = input.operations ? modelSceneStatistics(input.operations) : null;
  return {
    ready: stats !== null,
    loading: input.loading,
    error: input.error,
    stats,
    rows: modelInfoRows(stats)
  };
}

/** 聚焦模型信息：订阅 canvas 与 model-scene provider，派生规模行。 */
export function ModelInfoPanel({ ctx, nodeId }: { ctx: Context; nodeId: string }) {
  const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
  useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  useSyncExternalStore(
    provider?.subscribe ?? (() => () => undefined),
    () => provider?.getResources().get(nodeId)?.resourceKey ?? "",
    () => provider?.getResources().get(nodeId)?.resourceKey ?? ""
  );
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  const data = canvas?.nodeData?.[nodeId] as
    | { modelScriptStatus?: unknown; modelScriptError?: unknown }
    | undefined;
  // 历史浏览：本地 snapshot override 与主画面同源，切换版本后规模随之更新。
  const override = ctx.canvasRuntime.modelSceneOverride(nodeId);
  const operations = (override?.ops as readonly SceneV2Op[] | undefined)
    ?? provider?.getResources().get(nodeId)?.ops
    ?? null;
  const info = readModelInfo({
    operations,
    loading: operations === null && (provider?.isLoading?.(nodeId) ?? false),
    error: typeof data?.modelScriptError === "string" && data.modelScriptError !== ""
      ? data.modelScriptError
      : data?.modelScriptStatus === "failed"
        ? "模型脚本执行失败"
        : null
  });

  return (
    <section className="model-info" data-model-info="true" aria-label="模型信息">
      <div className="model-info__heading">
        <span className="model-info__title">模型信息</span>
        <span className="model-info__state" data-state={info.ready ? "ready" : info.error ? "error" : "pending"}>
          {info.ready ? "已就绪" : info.error ? "不可用" : "准备中"}
        </span>
      </div>
      {info.rows.length > 0 ? (
        <dl className="model-info__rows" data-model-info-rows="true">
          {info.rows.map((row) => (
            <div key={row.label} className="model-info__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="model-info__empty" role="status">
          {info.error ?? (info.loading ? "正在准备模型内容…" : "模型内容尚未就绪。")}
        </p>
      )}
      <p className="model-info__hint">点数与面数按运行时高精度档估算，不是 GPU 实测值。</p>
    </section>
  );
}
