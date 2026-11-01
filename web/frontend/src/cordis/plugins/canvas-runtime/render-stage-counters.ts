/**
 * 渲染计数的读取与解包（从 `bevy-runtime.ts` 原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`bevy-runtime.ts` 曾越过 800 物理行上限。这一段是纯函数：
 * 把一个诊断 JSON 解成结构化计数，不碰运行时实例、不持有状态。
 */
/** 渲染三阶段与实例数的累计计数（`perf.frame` 差分后求每帧均值）。 */
export type RenderStageCounters = {
  readonly stageQueueMs?: number;
  readonly stageQueueFrames?: number;
  readonly stagePrepareMs?: number;
  readonly stagePrepareFrames?: number;
  readonly stageRenderMs?: number;
  readonly stageRenderFrames?: number;
  readonly drawnInstances?: number;
  /** 主世界（Update 图）每帧墙钟累计：JS 帧循环与渲染三阶段之间的缺口只有它能回答。 */
  readonly stageMainMs?: number;
  readonly stageMainFrames?: number;
  /** 主世界里模型同步系统的每帧墙钟累计。 */
  readonly stageModelMs?: number;
  readonly stageModelFrames?: number;
  /** 预览卡片规模（`d`=延迟队列、`v`=可见、`l`=在途、`r`=就绪、`b`=纹理 MB）。 */
  readonly previews?: string;
};

/**
 * 从运行侧工作诊断里取渲染三阶段的累计墙钟与提交实例数（仅 dev 提供）。
 *
 * `perf.frame` 的 `fps`/`frameExecMs` 只覆盖 JS 帧循环：画布掉帧而这两个数没动时，
 * 只能靠这里的 Queue/Prepare/Render 分段回答「多出来的时间花在渲染提交、资源准备，
 * 还是根本不在本进程的渲染阶段里」。`drawnInstances` 与 `drawCalls` 配对，用来分辨
 * 「draw call 少」与「一次 instanced draw 带上万个实例」。
 *
 * 读不到（生产构建、原生 realm、诊断缺失）就返回空对象，绝不补 0 冒充"没花时间"。
 */
export function readRenderStageCounters(source: {
  canvas_work_diagnostics?: () => string;
}): RenderStageCounters & { readonly pacing?: string } {
  try {
    if (!source.canvas_work_diagnostics) return {};
    const diagnostics = JSON.parse(source.canvas_work_diagnostics()) as {
      renderStages?: { work?: Record<string, unknown>; draws?: Record<string, unknown> };
      previews?: Record<string, unknown>;
      pacing?: unknown;
    };
    const work = diagnostics.renderStages?.work ?? {};
    const draws = diagnostics.renderStages?.draws ?? {};
    const count = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const queueMs = count(work.queueMs);
    const queueFrames = count(work.queueFrames);
    const prepareMs = count(work.prepareMs);
    const prepareFrames = count(work.prepareFrames);
    const renderMs = count(work.renderMs);
    const renderFrames = count(work.renderFrames);
    const drawnInstances = count(draws.directInstances);
    const mainMs = count(work.mainMs);
    const mainFrames = count(work.mainFrames);
    const modelMs = count(work.modelMs);
    const modelFrames = count(work.modelFrames);
    const pacing =
      typeof diagnostics.pacing === "string" && diagnostics.pacing.length > 0
        ? diagnostics.pacing
        : undefined;
    // 模型卡片预览的排队/常驻规模。`pacing` 只说"还有子系统要帧"，这一条说"是哪一种、
    // 有多少"：`d`（deferred）常驻非零＝延迟队列没排空，`b`（纹理 MB）暴涨＝预算被吃满。
    const previews = previewGauges(diagnostics.previews);
    return {
      ...(queueMs === undefined ? {} : { stageQueueMs: queueMs }),
      ...(queueFrames === undefined ? {} : { stageQueueFrames: queueFrames }),
      ...(prepareMs === undefined ? {} : { stagePrepareMs: prepareMs }),
      ...(prepareFrames === undefined ? {} : { stagePrepareFrames: prepareFrames }),
      ...(renderMs === undefined ? {} : { stageRenderMs: renderMs }),
      ...(renderFrames === undefined ? {} : { stageRenderFrames: renderFrames }),
      ...(drawnInstances === undefined ? {} : { drawnInstances }),
      ...(mainMs === undefined ? {} : { stageMainMs: mainMs }),
      ...(mainFrames === undefined ? {} : { stageMainFrames: mainFrames }),
      ...(modelMs === undefined ? {} : { stageModelMs: modelMs }),
      ...(modelFrames === undefined ? {} : { stageModelFrames: modelFrames }),
      ...(pacing === undefined ? {} : { pacing }),
      ...(previews === undefined ? {} : { previews })
    };
  } catch {
    return {};
  }
}

/** 预览卡片规模压缩成一条短事实：`d`=延迟队列、`v`=可见、`l`=在途、`r`=就绪、`b`=纹理 MB。 */
function previewGauges(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const gauges = value as Record<string, unknown>;
  const read = (key: string): number | undefined => {
    const raw = gauges[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  };
  const deferred = read("deferred");
  const visible = read("visible");
  if (deferred === undefined && visible === undefined) return undefined;
  const megabytes = Math.round((read("textureBytes") ?? 0) / (1024 * 1024));
  return `d${deferred ?? 0},v${visible ?? 0},l${read("live") ?? 0},r${read("ready") ?? 0},b${megabytes}`;
}
