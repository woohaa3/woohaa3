/**
 * 本机遥测事件契约（change: 2026-10-20-add-local-client-telemetry，design D3）。
 *
 * 三条口径：
 * - **白名单**：`name` / `result` / `origin` / `surface` 与属性键都取自固定常量；未知值丢弃，
 *   不接受现拼键名，也不接受任意属性。
 * - **有界**：每个字段都有长度/数量/取值上限，`TELEMETRY_LIMITS` 是唯一来源。
 * - **无用户内容**：prompt、标题、文件名、画布名、URL、媒体地址一律不进入事件；这里不做
 *   "先收进来再过滤"，而是结构上就没有能装这些内容的字段。
 *
 * 与 `woohaa.telemetry.v1alpha1` 的关系：`name`/`result`/`origin`/`surface` 与 proto 的
 * `Action`/`Result`/`Client`/`Surface` 一一对应（`task.terminal` 除外，它没有对应枚举）；
 * `durationMs`/`errorCode`/`attributes` 也随协议扩展上报（change:
 * 2026-10-25-enhance-telemetry-performance-collection，design D6），不再是有损投影。
 */

/** 事件名白名单。新增一个名字等于新增一类可复盘事实，必须同时补异常规则与文档。 */
export const TELEMETRY_EVENT_NAMES = [
  "canvas.open",
  "canvas.save",
  "canvas.edit",
  "sync.connect",
  "sync.reconcile",
  "local.validation",
  "task.terminal",
  // 性能事实（change: 2026-10-25-enhance-telemetry-performance-collection，design D2）。
  // 四个名字代替一个 `perf.sample`：`kind` 与 `stage` 的取值集合不同，混在一个名字里
  // 会让 `groupBy` 的分组结果无法解释。
  "perf.startup",
  "perf.interaction",
  "perf.segment",
  "perf.frame",
  /**
   * 一次总览 LOD 采样：当前可见画布上**所有声明总览 LOD 的片场**的档位分布
   * （2026-10-28 片场总览 LOD 遥测采样）。
   *
   * 只记聚合计数，不携带完整节点 ID、标题或任何画布内容：这条事实回答"看画布时片场停在哪档"；
   * dev 构建另带 `owners`（节点 id 末 12 字符摘要）用于把非总览档位的根落到可回查的个体，
   * 以及 `pins`（当前截图 pin 的目标节点摘要）用于回答"是谁把它按在 High"，发布构建不携带。
   */
  "perf.lod",
  /**
   * 扩展贡献在宿主中渲染或回调失败（change: 2026-10-21-harden-extension-fault-isolation）。
   * 只带 `extension`/`slot`/`epoch` 属性与错误类别 `errorCode`，不带错误消息与堆栈。
   */
  "extension.render-failed"
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export const TELEMETRY_RESULTS = ["success", "failure", "cancelled", "rejected"] as const;
export type TelemetryResult = (typeof TELEMETRY_RESULTS)[number];

/** 事件产生的位置。与 proto 的 `Client` 对应。 */
export const TELEMETRY_ORIGINS = ["browser", "desktop", "local-host"] as const;
export type TelemetryOrigin = (typeof TELEMETRY_ORIGINS)[number];

/** 事件发生的界面面。与 proto 的 `Surface` 对应；`task` 无对应值。 */
export const TELEMETRY_SURFACES = ["canvas", "editor", "sync", "local-validation", "task"] as const;
export type TelemetrySurface = (typeof TELEMETRY_SURFACES)[number];

/**
 * 允许出现的属性键。
 *
 * 这些键名固定成常量而不是由调用点现拼：键名决定复盘页与聚合的展示口径，改名等于改口径，
 * 必须显式改这里（同 `base/diagnostics.ts` 的 `ATTRIBUTE_KEYS` 取向）。
 */
export const TELEMETRY_ATTRIBUTE_KEYS = [
  "canvas",
  // 一次画布会话的标识（32 位小写十六进制，管理端只做聚合与关联）。
  // 与 trace_id 的分工：trace 关联一次操作，session 关联“用户这次进入画布后的
  // 全部动作”。没有它，管理端只能按 actor + 时间窗猜会话边界。
  "session",
  "node",
  "provider",
  "model",
  "phase",
  "status",
  "code",
  "source",
  "version",
  // 性能事件的维度与计数（change: 2026-10-25-enhance-telemetry-performance-collection）。
  // `mode` / `kind` / `stage` 是封闭枚举；其余是窗口累计计数（数值型属性）。
  "mode",
  "kind",
  "stage",
  // JS 帧循环执行次数/秒（`perf.frame`）：含输入触发的强制 flush，不是画布出帧率。
  "fps",
  // 画布实际出帧率（`perf.frame`，仅 dev 能读到渲染器计数时携带）：与开发期 FPS 徽标同源，
  // 是 Bevy Render PostCleanup 的完成帧率（不代表 GPU present）。`fps` 高而 `renderFps` 低，
  // 说明瓶颈在渲染侧；两者都低才是更新循环被按住。
  "renderFps",
  "sceneBuilds",
  "sceneSubmits",
  "sceneDedupes",
  "viewportSubmits",
  "positionSubmits",
  "stringify",
  "wasmAcceptMs",
  "frameExecMs",
  "frameExecutions",
  // 每帧 3D 主 pass 的 draw call 记录数（`perf.frame`，仅 dev 可读时携带）：
  // 5 秒级回归里 `fps` 看不出的"画得太多"由这条回答（2026-10-28 片场总览 LOD 修复）。
  "drawCalls",
  // 每帧提交的模型实例数（`perf.frame`，仅 dev）：draw call 少不等于画得少，
  // 一次 instanced draw 可以带上万个实例。AABB 失效/批级剔除漏掉时，`drawCalls`
  // 仍在个位数而这里会顶到几千上万。
  "drawnInstances",
  // 主世界（Update 图）每帧墙钟与其中模型同步系统的每帧墙钟（`perf.frame`，仅 dev）。
  // `frameExecMs` 只覆盖 JS 帧循环、渲染三阶段只覆盖 render sub-app，两者之间的缺口
  // （模型同步、预览准入、LOD、块布局）只有这两项能回答。
  "mainMs",
  "modelMs",
  // 渲染三阶段的每帧平均墙钟（`perf.frame`，仅 dev）：Queue / Prepare / Render。
  // `fps` 掉下来而 `frameExecMs`（JS 帧循环）没涨时，就靠这三个数回答"多出来的时间
  // 花在渲染提交、资源准备，还是根本不在本进程的渲染阶段里"。
  "queueMs",
  "prepareMs",
  "renderMs",
  // 模型卡片预览的规模快照（`perf.frame`，仅 dev）：`d`=延迟队列、`v`=可见、`l`=在途、
  // `r`=就绪、`b`=纹理 MB。`pacing` 只说"还有子系统要连续帧"，这条说"是哪一种、多大"。
  "previews",
  // 帧内最贵的几步（`perf.frame`，仅 dev）：`<步骤>:<每帧 ms>`，按每帧耗时取前三。
  // `frameExecMs` 只说"这一帧花了多少"，这条回答"花在 viewport-notify、image-sync、
  // video-sync 还是 composite-media-sync"——片场相关的逐帧会话同步就在这里露头。
  "steps",
  // 总览 LOD 采样（`perf.lod`）的分布计数：实际已发布档位、准备中数量与最大投影占比。
  // 只做聚合，不引入节点维度；`maxAttributes` 仍能装下一条样本。
  "low",
  "medium",
  "high",
  "preparing",
  "fractionMax",
  // 总览 LOD 的原因分布（`perf.lod`）：`overview=12,offscreen=2` 形式的固定词表计数。
  // 用来区分「同一档位」下的不同成因（屏外未决策 / 高优先消费者 / 退化 bounds），
  // 不含节点身份；词表封闭，长度有界。
  "reasons",
  // 总览 LOD 的非总览根摘要（`perf.lod`，仅 dev 构建）：`<nodeId 末 12 字符>:<原因>`。
  // 回答「到底是哪几个根停在 High」——只给不透明摘要，用于本机回查画布文档，
  // 不含标题/素材/脚本；最多 3 条，超出以 `+N` 收尾。
  "owners",
  // 当前截图 pin 的目标节点摘要（`perf.lod`，仅 dev 构建）：`capture.pins` 里的节点 id 末 12 字符。
  // 与 `owners` 的区别：`owners` 是被 pin 住的根，`pins` 是发起 pin 的截图目标
  // （可能是镜头预览节点），用来区分「整场截图/视频导出」与「镜头参考录制」。最多 3 条 + `+N`。
  "pins",
  // 总览 LOD 采样的画布侧旁证（`perf.lod`，仅 dev 构建）：这一帧激活的离屏预览相机数，
  // 与渲染器持有的模型 mesh 实体数。draw call 是所有视图的合计，这两个数把
  // 「几何多」与「同一份几何被多个离屏相机重复画」区分开。
  "views",
  "entities",
  // 绘制结构的旁证（`perf.lod`，仅 dev 构建）：总部件数、已进入静态批次的部件数、
  // 批次实体数。用来区分「部件太多无法合批」与「合批粒度过细（同材质被网格切片拆开）」。
  "parts",
  "batched",
  "batches",
  // 帧节奏状态（`perf.lod`，仅 dev 构建）：`idle` / `dwell` / `active:<忙碌项列表>`。
  // 静止降频是否真的落在停帧上只能从运行侧读；没生效时这份词表指出是哪一项一直要求连续帧。
  "pacing",
  // 总览片场栅格缓存状态（`perf.lod`，仅 dev）：`sets=N,live=M,high=..,hot=..,pin=..,bounds=..,layer=..`。
  // 用来判读「每个片场一张缓存图」是否真的接管，以及没接管时卡在哪一条件。
  "raster",
  /** 扩展身份（`extension.render-failed`）：宿主盖章的 extensionId，不是用户内容。 */
  "extension",
  /** 宿主 slot 名（`extension.render-failed`）。 */
  "slot",
  /** 扩展装配 epoch（`extension.render-failed`）。 */
  "epoch"
] as const;

export type TelemetryAttributeKey = (typeof TELEMETRY_ATTRIBUTE_KEYS)[number];

/**
 * 构建模式（change: 2026-10-25-enhance-telemetry-performance-collection，design D3）。
 *
 * 取值由编译期常量决定，MUST NOT 来自 URL、设置项或运行时探测：回归对比的第一条前提是
 * "两次样本来自同一构建模式"。`preview` 与 `production` 必须可区分——preview 不压缩、
 * 带 sourcemap，帧时间与发布构建不同。
 */
export const TELEMETRY_PERF_MODES = ["dev", "preview", "production"] as const;
export type TelemetryPerfMode = (typeof TELEMETRY_PERF_MODES)[number];

/**
 * 启动阶段（`perf.startup` 的 `stage`）。
 *
 * 名字与已删除的 `LifecycleStage` 刻意不重合：那套 span 记录的是"落盘管线里的阶段"，这套
 * 只记录"启动路径上可计时的墙钟段"，两者的边界不同，复用名字会让读者以为是同一件事。
 */
export const TELEMETRY_PERF_STARTUP_STAGES = [
  "wasm-module",
  "scene-build",
  "app-scope",
  "canvas-scope",
  "session-open",
  "bevy-runtime"
] as const;

/** 一次输入内可计时的子段（`perf.segment` 的 `stage`，并集含启动阶段名以外的固定集合）。 */
export const TELEMETRY_PERF_SEGMENT_STAGES = [
  "hit-query",
  "gesture-begin",
  "gesture-move",
  "gesture-commit",
  "viewport-apply",
  "scene-build",
  "frame-submit"
] as const;

/** `stage` 的完整封闭集合 = 启动阶段 ∪ 输入子段。 */
export const TELEMETRY_PERF_STAGES = [
  ...TELEMETRY_PERF_STARTUP_STAGES,
  ...TELEMETRY_PERF_SEGMENT_STAGES
] as const;
export type TelemetryPerfStage = (typeof TELEMETRY_PERF_STAGES)[number];

/**
 * 被消费的画布输入种类（`perf.interaction` / `perf.segment` 的 `kind`）。
 *
 * 只记"被消费的手势"，不记 `pointermove`：一次平移拖动会消费成百上千次 PointerMove，
 * 逐条写库既撞保留上限，也让"这一类输入有多慢"被移动噪声淹没。
 */
export const TELEMETRY_PERF_INPUT_KINDS = [
  "pan",
  "wheel-pan",
  "zoom",
  "drag",
  "resize",
  "connect",
  "marquee",
  "double-click",
  "context-menu"
] as const;
export type TelemetryPerfInputKind = (typeof TELEMETRY_PERF_INPUT_KINDS)[number];

/**
 * 每类性能事件的合法属性键集合（封闭）。
 *
 * 校验与文档都引用这一份：`perf.startup` 不该出现 `kind`，`perf.interaction` 不该出现
 * `stage`——混进来会让 `groupBy` 的分组结果出现"这个 kind 的 stage 是空的"这种无法解释的行。
 */
export const TELEMETRY_PERF_ATTRIBUTE_KEYS: Readonly<
  Record<"perf.startup" | "perf.interaction" | "perf.segment" | "perf.frame" | "perf.lod", readonly TelemetryAttributeKey[]>
> = {
  "perf.startup": ["mode", "stage"],
  "perf.interaction": ["mode", "kind"],
  "perf.segment": ["mode", "kind", "stage"],
  "perf.frame": [
    "mode",
    "fps",
    "renderFps",
    "sceneBuilds",
    "sceneSubmits",
    "sceneDedupes",
    "viewportSubmits",
    "positionSubmits",
    "stringify",
    "wasmAcceptMs",
    "frameExecMs",
    "frameExecutions",
    "drawCalls",
    "drawnInstances",
    "queueMs",
    "prepareMs",
    "renderMs",
    "steps",
    "previews",
    "mainMs",
    "modelMs",
    // 帧节奏标签（仅 dev）：`idle` / `dwell` / `active:<忙碌项>`。帧率掉下来时，
    // 先看它是不是有一项一直要求连续帧，再决定查渲染耗时还是查"谁在叫醒循环"。
    "pacing"
  ],
  // 只记分布、准备状态与原因分布；`owners`/`pins` 仅 dev 构建携带，且只放节点 id 的末 12 字符摘要。
  "perf.lod": [
    "mode",
    "low",
    "medium",
    "high",
    "preparing",
    "fractionMax",
    "reasons",
    "owners",
    "pins",
    "views",
    "entities",
    "parts",
    "batched",
    "batches",
    // 帧节奏与总览片场栅格缓存状态（仅 dev）：排障时回答"缓存有没有接管、为什么没接管"。
    // 漏登记会让整条样本在契约校验里被判非法、静默丢弃——2026-10-29 就这样丢了几小时样本。
    "pacing",
    "raster"
  ]
};

/** 每类性能事件必须携带的属性键；缺任何一个整条丢弃（不是补默认值）。 */
export const TELEMETRY_PERF_REQUIRED_ATTRIBUTES: Readonly<
  Record<"perf.startup" | "perf.interaction" | "perf.segment" | "perf.frame" | "perf.lod", readonly TelemetryAttributeKey[]>
> = {
  "perf.startup": ["mode", "stage"],
  "perf.interaction": ["mode", "kind"],
  "perf.segment": ["mode", "kind", "stage"],
  "perf.frame": ["mode"],
  // 分布计数缺一不可：一条只有 `mode` 的样本无法解释"哪个档位有多少片场"。
  "perf.lod": ["mode", "low", "medium", "high"]
};

/**
 * 帧窗口长度（`perf.frame` 的聚合窗口）。
 *
 * 常量而不是设置项：采样窗口一变，历史样本的 p95 立刻不可比，而本机没有任何机制标注
 * "这条样本用的是哪档采样"（design D7）。60 s 一条 = 60 行/小时，与既有事件量级同阶。
 */
export const TELEMETRY_PERF_FRAME_WINDOW_MS = 60_000;

/** 是否性能事件名（决定属性校验走严格分支）。 */
export function isTelemetryPerfEventName(value: unknown): value is keyof typeof TELEMETRY_PERF_ATTRIBUTE_KEYS {
  return (
    value === "perf.startup" ||
    value === "perf.interaction" ||
    value === "perf.segment" ||
    value === "perf.frame" ||
    value === "perf.lod"
  );
}

/** 唯一的上限来源；实现与测试都读这里，不各自写数字。 */
export const TELEMETRY_LIMITS = {
  /**
   * 单条事件最多属性对。
   *
   * 从 8 提到 12：`perf.frame` 要一条装下窗口内的十项计数 + `mode`（design D2/D4）。
   * 从 12 提到 13：`perf.frame` 再带一条 `renderFps`（画布实际出帧率），否则它会被挤掉，
   * 而"画布掉帧"正是 `fps`（JS 帧循环次数）回答不了的那个问题。
   * 从 13 提到 18：帧率掉下来时要能定位到"时间花在哪"——`drawnInstances`（实例数）
   * 把「画得少」与「draw call 少但实例多」分开，`queueMs`/`prepareMs`/`renderMs`
   * 把渲染三阶段拆开，`pacing` 指出还有没有子系统在要求连续帧。
   * 再提到 19：`steps` 直接把帧内最贵的三步写进同一条事实。
   * 再提到 20：`previews` 把预览延迟队列与纹理占用写进同一条事实。
   * 再提到 22：`mainMs`/`modelMs` 补上主世界那一层（JS 与渲染三阶段都没覆盖）。
   * 上限仍在，属性键集合也仍是封闭枚举，所以基数与长度都有界。
   */
  maxAttributes: 22,
  /** 属性值单行最大字符数（按码点截断，中文不会被切坏）。 */
  maxAttributeValueLength: 128,
  /** 属性序列化后最大字节数；超预算按排序确定性丢弃。 */
  maxAttributesBytes: 1024,
  /** 错误码最大长度（与 `[a-z0-9][a-z0-9_.:-]{0,63}` 一致）。 */
  maxErrorCodeLength: 64,
  /** `trace_id` 固定 32 位小写十六进制。 */
  traceIdLength: 32,
  /** 前端版本最大长度（与 proto 的 `frontend_version` 一致）。 */
  maxFrontendVersionLength: 64,
  /** 耗时上限：一天。超过视为坏数据而不是"很慢"。 */
  maxDurationMs: 86_400_000,
  /** 客户端时钟超前于宿主时钟的可接受窗口；超过即视为不可信时间。 */
  maxClockSkewMs: 5 * 60 * 1000,
  /** 单批最多事件数（与 proto 的 `ReportEvents` 一致）。 */
  maxBatchEvents: 100,
  /** 单请求体上限。仓库无统一 helper，按 `task-inspection-api.ts` 的 64 KiB。 */
  maxRequestBytes: 64 * 1024
} as const;

/** 一条本机遥测事实。 */
export type TelemetryEvent = {
  readonly name: TelemetryEventName;
  readonly result: TelemetryResult;
  readonly origin: TelemetryOrigin;
  readonly surface?: TelemetrySurface;
  /** 操作耗时；缺失表示该事件不度量耗时。 */
  readonly durationMs?: number;
  /** 稳定错误码（不是错误消息）。 */
  readonly errorCode?: string;
  /** 关联标识；32 位小写十六进制。 */
  readonly traceId?: string;
  /** 上报端构建版本；服务端只做形状校验，因此这里同样只留形状。 */
  readonly frontendVersion?: string;
  /** 上报端时钟（epoch ms）；`0` 表示不可信/未知。窗口与保留永远不认它。 */
  readonly occurredAt: number;
  /** 有界键值细节；键来自 `TELEMETRY_ATTRIBUTE_KEYS`。 */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * 调用点用来发事件的输入形状。
 *
 * 与 `TelemetryEvent` 只差 `occurredAt` 可缺省（缺省取宿主当前时间）。字段仍可能非法——
 * 归一在 `normalizeTelemetryEvent` 里统一做，调用点不需要自己校验。
 */
export type TelemetryEventInput = Omit<TelemetryEvent, "occurredAt"> & { readonly occurredAt?: number };

const EVENT_NAME_SET: ReadonlySet<string> = new Set(TELEMETRY_EVENT_NAMES);
const RESULT_SET: ReadonlySet<string> = new Set(TELEMETRY_RESULTS);
const ORIGIN_SET: ReadonlySet<string> = new Set(TELEMETRY_ORIGINS);
const SURFACE_SET: ReadonlySet<string> = new Set(TELEMETRY_SURFACES);
const ATTRIBUTE_KEY_SET: ReadonlySet<string> = new Set(TELEMETRY_ATTRIBUTE_KEYS);
const PERF_MODE_SET: ReadonlySet<string> = new Set(TELEMETRY_PERF_MODES);
const PERF_STAGE_SET: ReadonlySet<string> = new Set(TELEMETRY_PERF_STAGES);
const PERF_INPUT_KIND_SET: ReadonlySet<string> = new Set(TELEMETRY_PERF_INPUT_KINDS);

const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const FRONTEND_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function isTelemetryEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && EVENT_NAME_SET.has(value);
}

export function isTelemetryResult(value: unknown): value is TelemetryResult {
  return typeof value === "string" && RESULT_SET.has(value);
}

export function isTelemetryOrigin(value: unknown): value is TelemetryOrigin {
  return typeof value === "string" && ORIGIN_SET.has(value);
}

export function isTelemetrySurface(value: unknown): value is TelemetrySurface {
  return typeof value === "string" && SURFACE_SET.has(value);
}

export function isTelemetryAttributeKey(value: unknown): value is TelemetryAttributeKey {
  return typeof value === "string" && ATTRIBUTE_KEY_SET.has(value);
}

export function isTelemetryPerfMode(value: unknown): value is TelemetryPerfMode {
  return typeof value === "string" && PERF_MODE_SET.has(value);
}

export function isTelemetryPerfStage(value: unknown): value is TelemetryPerfStage {
  return typeof value === "string" && PERF_STAGE_SET.has(value);
}

export function isTelemetryPerfInputKind(value: unknown): value is TelemetryPerfInputKind {
  return typeof value === "string" && PERF_INPUT_KIND_SET.has(value);
}

/** 按码点截断，避免把代理对或中文切坏。 */
export function truncateByCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/** 把控制字符与换行折叠成单个空格，并去掉首尾空白。 */
export function foldSingleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 归一一条事件。返回 `null` 表示这条事件必须整条丢弃（未知 `name`/`result`/`origin`）。
 *
 * 其余字段的非法值一律**丢该字段而不丢整条**：一次上报是一批，为一个可疑字段丢掉同批其它
 * 合法事实不值得。
 */
export function normalizeTelemetryEvent(input: unknown, options: { now?: number } = {}): TelemetryEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const { name, result, origin } = raw;
  if (!isTelemetryEventName(name) || !isTelemetryResult(result) || !isTelemetryOrigin(origin)) return null;
  const now = options.now ?? Date.now();
  const event: {
    -readonly [K in keyof TelemetryEvent]: TelemetryEvent[K];
  } = {
    name,
    result,
    origin,
    occurredAt: normalizeOccurredAt(raw.occurredAt, now)
  };

  if (isTelemetrySurface(raw.surface)) event.surface = raw.surface;

  const durationMs = normalizeDuration(raw.durationMs);
  if (durationMs !== undefined) event.durationMs = durationMs;

  const errorCode = normalizeErrorCode(raw.errorCode);
  if (errorCode !== undefined) event.errorCode = errorCode;

  const traceId = normalizeTraceId(raw.traceId);
  if (traceId !== undefined) event.traceId = traceId;

  const frontendVersion = normalizeFrontendVersion(raw.frontendVersion);
  if (frontendVersion !== undefined) event.frontendVersion = frontendVersion;

  const attributes = normalizeAttributes(raw.attributes);
  if (attributes !== undefined) event.attributes = attributes;

  // 全零 trace_id 单独判掉：形状合法但没有关联意义。
  if (event.traceId !== undefined && /^0{32}$/.test(event.traceId)) delete event.traceId;

  // 性能事件比其它事件严格：属性键集合封闭、必填键缺一不可、枚举值必须合法。
  // 这些条件下"丢该字段"没有意义——没有 `mode` 的样本进不了任何可比的分位数
  // （design D3），因此整条丢弃。
  if (isTelemetryPerfEventName(name) && !isValidPerfAttributes(name, event.attributes)) return null;

  return event;
}

/**
 * 校验性能事件的属性。
 *
 * 三条规则都来自 spec：属性键集合封闭、必填键必须存在、`mode`/`stage`/`kind` 必须是
 * 封闭枚举里的值。返回 `false` 表示整条丢弃（与其它事件的"丢字段"策略不同）。
 */
function isValidPerfAttributes(
  name: keyof typeof TELEMETRY_PERF_ATTRIBUTE_KEYS,
  attributes: Readonly<Record<string, string | number | boolean>> | undefined
): boolean {
  const allowed = TELEMETRY_PERF_ATTRIBUTE_KEYS[name];
  const required = TELEMETRY_PERF_REQUIRED_ATTRIBUTES[name];
  const current = attributes ?? {};
  for (const key of Object.keys(current)) {
    if (!(allowed as readonly string[]).includes(key)) return false;
  }
  for (const key of required) {
    if (current[key] === undefined) return false;
  }
  if (current.mode !== undefined && !isTelemetryPerfMode(current.mode)) return false;
  if (current.stage !== undefined && !isTelemetryPerfStage(current.stage)) return false;
  if (current.kind !== undefined && !isTelemetryPerfInputKind(current.kind)) return false;
  // LOD 分布是计数与占比：负数/非有限值会让聚合表把"没数据"画成负档位，整条丢弃。
  // draw call 是每帧计数：负数/非整数无法与基线对账，整条丢弃。
  if (name === "perf.frame" && current.drawCalls !== undefined) {
    const value = current.drawCalls;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  }
  if (name === "perf.lod") {
    for (const key of ["low", "medium", "high", "preparing", "fractionMax", "views", "entities", "parts", "batched", "batches"] as const) {
      const value = current[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
    }
    // `owners` 是本机定位用的非总览根摘要：字符串、最多 4 段（3 条 + `+N`），
    // 语义由采样侧保证，这里只守住形状与基数。
    if (current.owners !== undefined) {
      const owners = current.owners;
      if (typeof owners !== "string") return false;
      const parts = owners.split(",");
      if (parts.length > 4) return false;
      if (parts.some((part) => part === "" || part.length > 40)) return false;
    }
    // `pins` 同形状：3 条摘要 + `+N`，语义由采样侧保证。
    if (current.pins !== undefined) {
      const pins = current.pins;
      if (typeof pins !== "string") return false;
      const parts = pins.split(",");
      if (parts.length > 4) return false;
      if (parts.some((part) => part === "" || part.length > 40)) return false;
    }
  }
  return true;
}

function normalizeOccurredAt(value: unknown, now: number): number {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  // 超前超过可接受偏差 → 不可信，存 0。早于保留期的判定在存储侧做（它才知道保留配置）。
  if (ms - now > TELEMETRY_LIMITS.maxClockSkewMs) return 0;
  return Math.floor(ms);
}

function normalizeDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > TELEMETRY_LIMITS.maxDurationMs) return undefined;
  return Math.round(value);
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !ERROR_CODE_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!TRACE_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeFrontendVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !FRONTEND_VERSION_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 归一属性：未在白名单里的键逐对丢弃，值折叠单行并按码点截断，超过条数或字节预算时按
 * **排序后的确定性顺序**丢弃尾部。返回 `undefined` 表示一个都没留下。
 */
function normalizeAttributes(
  value: unknown
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isTelemetryAttributeKey(key)) continue;
    const normalized = normalizeAttributeValue(raw);
    if (normalized === undefined) continue;
    entries.push([key, normalized]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const kept: Array<[string, string | number | boolean]> = [];
  for (const entry of entries) {
    if (kept.length >= TELEMETRY_LIMITS.maxAttributes) break;
    const candidate = [...kept, entry];
    if (utf8ByteLength(JSON.stringify(Object.fromEntries(candidate))) > TELEMETRY_LIMITS.maxAttributesBytes) {
      break;
    }
    kept.push(entry);
  }
  if (kept.length === 0) return undefined;
  return Object.fromEntries(kept);
}

/**
 * UTF-8 字节数。`contracts` 同时被浏览器与宿主使用，因此不能用 Node 的 `Buffer`。
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const folded = foldSingleLine(value);
  if (folded === "") return undefined;
  return truncateByCodePoints(folded, TELEMETRY_LIMITS.maxAttributeValueLength);
}
