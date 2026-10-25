/**
 * 遥测采集的**零依赖原语**与「当前客户端」引用槽
 * （change: 2026-10-20-add-local-client-telemetry，design D7；
 *   change: 2026-10-25-enhance-telemetry-performance-collection，design D3/D7）。
 *
 * 为什么单独一个模块：`canvas-session` / `canvas-session-transport` / `install-services` /
 * `page-scope` 都在**入口静态闭包**里，而采集实现（`telemetry-client.ts` + 契约的事件模块）
 * 不该为每个用户都在启动时加载。所以这里只保留极小的东西——单调时钟、稳定错误码归一、
 * 构建模式、启动/输入计时器，以及一个可被替换的客户端引用；真正的客户端与帧窗口聚合由
 * App scope 启动时动态 import 安装。
 *
 * 引用槽的语义：未安装即 `undefined`（埋点整体 no-op）。这是刻意的——遥测永远不是画布启动的前置条件。
 *
 * 这里不 import 契约：本模块进的是启动闭包，事件形状的校验发生在契约的
 * `normalizeTelemetryEvent`（宿主侧）。代价是枚举在这里按字符串比较，因此每个取值都必须与
 * `client/web/contracts/src/telemetry/event.ts` 的封闭集合一致（契约单测锁定那一边）。
 */
import type { TelemetryClient } from "./telemetry-client.js";

// 纯类型 re-export（编译期擦除）：消费方只从这里取，就不会把采集实现拉进入口闭包。
export type { TelemetryClient } from "./telemetry-client.js";

/** 错误码形状与契约 `TELEMETRY_LIMITS.maxErrorCodeLength` 一致。 */
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/**
 * 埋点耗时统一取 `performance.now()` 差值（单调时钟，不受系统时间调整影响）。
 *
 * 缺少 `performance` 时退回 `Date.now()`（仍只用于差值）；不引入新的计时框架。
 */
export function telemetryNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/**
 * 把任意拒绝码/错误文案映射成稳定短码。
 *
 * 事件里只允许稳定短码（不是错误消息）：中文文案、服务端 message、带空格的英文都不能进入，
 * 否则同一类失败会因文案变化被聚成许多不同 code（复盘时无法按 code 计数）。
 */
export function stableTelemetryErrorCode(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const folded = value.trim().toLowerCase();
  if (folded === "" || !ERROR_CODE_PATTERN.test(folded)) return fallback;
  return folded;
}

/** 当前已安装的采集客户端（`installTelemetryClient` 写入；未安装即 no-op）。 */
let activeClient: TelemetryClient | undefined;

/** 可选解析：已经安装就返回，否则 `undefined`。 */
export function activeTelemetryClient(): TelemetryClient | undefined {
  return activeClient;
}

/** 安装/替换当前客户端；传 `undefined` 表示卸载。 */
export function setActiveTelemetryClient(client: TelemetryClient | undefined): void {
  activeClient = client;
}

/** 测试：替换/清除"当前已安装客户端"（照 `setAppBasePathForTesting` 的先例）。 */
export function setTelemetryClientForTesting(client: TelemetryClient | undefined): void {
  activeClient = client;
}

// ---- 构建模式（change: 2026-10-25-enhance-telemetry-performance-collection，design D3）----

/**
 * 构建模式：`dev` / `preview` / `production`，`undefined` 表示构建常量缺失。
 *
 * 只看编译期常量：`import.meta.env.DEV` 是开发服务器，`MODE=preview` 是 preview 构建，
 * `MODE=production`（以及桌面壳用的 `desktop`）是发布构建。**不从 URL、设置项或运行时
 * 探测推断**：回归对比的第一条前提是"两次样本来自同一构建模式"。
 */
export type TelemetryBuildMode = "dev" | "preview" | "production";

type BuildEnv = { readonly DEV?: boolean; readonly MODE?: string; readonly PROD?: boolean };

function readBuildEnv(): BuildEnv | undefined {
  try {
    // `import.meta.env` 只在 vite 里存在；直接跑源码的测试里它是空对象。
    return (import.meta.env as BuildEnv | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从构建环境常量解析模式。
 *
 * 参数缺省时读真实的 `import.meta.env`；显式传 `null` 表示"宿主没有注入构建常量"
 * （返回 `undefined`，而不是回落到真实环境——测试与原生宿主都靠这个区分）。
 */
export function resolveTelemetryBuildMode(
  env: BuildEnv | null | undefined = readBuildEnv()
): TelemetryBuildMode | undefined {
  if (!env) return undefined;
  if (env.DEV === true) return "dev";
  switch (env.MODE) {
    case "preview":
      return "preview";
    case "production":
    case "desktop":
      return "production";
    case "development":
      return "dev";
    default:
      return env.PROD === true ? "production" : undefined;
  }
}

/** 构建模式在模块初始化时固定一次；`undefined` 时**不发**任何 `perf.*`（不以 `unknown` 占位）。 */
let buildMode: TelemetryBuildMode | undefined = resolveTelemetryBuildMode();

/** 当前构建模式；`undefined` 表示构建常量缺失。 */
export function telemetryBuildMode(): TelemetryBuildMode | undefined {
  return buildMode;
}

/** 测试：固定/清除模块级构建模式。 */
export function setTelemetryBuildModeForTesting(mode: TelemetryBuildMode | undefined): void {
  buildMode = mode;
}

/** 一条性能事件的采集前提：有客户端、有构建模式。 */
function canRecordPerf(): boolean {
  return buildMode !== undefined && activeClient !== undefined;
}

/**
 * 当前是否具备采集条件（客户端已装、构建模式已知）。
 *
 * 调用点用它省掉热路径上的计时读取：条件不成立时不读时钟、不建收集器。它只回答"现在能不能
 * 发"，不是采样开关——采样口径是常量（design D7），不随它变化。
 */
export function isPerfCollectionEnabled(): boolean {
  return canRecordPerf();
}

/** 同步发送一条性能事件；任何异常都吞掉（采集不得进入业务路径）。 */
function emitPerf(
  name: "perf.startup" | "perf.interaction" | "perf.segment",
  durationMs: number,
  attributes: Record<string, string | number>,
  result: "success" | "failure" | "cancelled" | "rejected" = "success"
): void {
  try {
    activeClient?.record({
      name,
      result,
      origin: "browser",
      surface: "canvas",
      durationMs: Math.max(0, Math.round(durationMs)),
      attributes: { mode: buildMode as string, ...attributes }
    });
  } catch {
    // 见文件头：单条事实失败不影响调用方。
  }
}

// ---- 启动阶段计时（`perf.startup`）----

/**
 * 开始一段启动计时；返回的结束函数发一条 `perf.startup`。
 *
 * **采集条件在结束时判定，不在开始时判定**：客户端是 App scope 启动后动态 import 安装的
 * （首屏体积，见 `install-services.ts`），在它装好之前开始的 `app-scope` 阶段恰恰是最有价值
 * 的那一段。开始时判条件会把所有早于客户端安装的启动阶段变成空样本，让"启动耗时"只剩后半段。
 * 代价是每段多两次单调时钟读取——启动阶段只有个位数，可忽略。
 *
 * 构建模式缺失时仍然不发：未知模式的样本会让基线与观测不可比（design D3）。重复结束只发一次。
 */
export function beginStartupSpan(stage: string): (result?: "success" | "failure") => void {
  const started = telemetryNow();
  let done = false;
  return (result = "success") => {
    if (done) return;
    done = true;
    if (!canRecordPerf()) return;
    emitPerf("perf.startup", telemetryNow() - started, { stage }, result);
  };
}

/** 记录一段已经测好的启动耗时。 */
export function recordStartupSpan(stage: string, durationMs: number, result: "success" | "failure" = "success"): void {
  if (!canRecordPerf()) return;
  emitPerf("perf.startup", durationMs, { stage }, result);
}

// ---- 一次被消费的输入（`perf.interaction` + `perf.segment`）----

export type PerfInteractionHandle = {
  /** 同步包住一个已计时的子阶段；不改变返回值或异常。 */
  segment<T>(stage: string, run: () => T): T;
  /** 追加一段已经测好的子耗时。 */
  push(stage: string, durationMs: number): void;
  /**
   * 结束并发送；重复调用只发一次。
   *
   * `endedAt` 用于"最后一段活动已经结束、但结算要等空闲判定"的调用点（滚轮段）：不传则以
   * 调用时刻为终点，那会把等待空闲的时长算进这次输入的耗时里。
   */
  finish(result?: "success" | "failure" | "cancelled" | "rejected", endedAt?: number): void;
};

const NOOP_INTERACTION: PerfInteractionHandle = {
  segment: (_stage, run) => run(),
  push: () => undefined,
  finish: () => undefined
};

/**
 * 一次被消费的画布输入的收集器（design D2）。
 *
 * 只在**确认消费**之后调用；被门禁拒绝的输入不创建收集器，因此不会产生 `perf.interaction`
 * （spec: 拒绝输入不发）。子阶段耗时只追加统计，不增加查询、序列化或渲染调用。
 *
 * `startedAt` 用于"共享输入入口已经开始计时、但当时还不知道这次输入会被消费成哪种 kind"
 * 的调用点（滚轮先分类后消费、指针手势在抬起时才知道是 pan 还是 context-menu）。不传即以
 * 调用时刻为起点。
 */
export function beginPerfInteraction(kind: string, startedAt?: number): PerfInteractionHandle {
  if (!canRecordPerf()) return NOOP_INTERACTION;
  const started = startedAt ?? telemetryNow();
  const segments: Array<{ stage: string; durationMs: number }> = [];
  let finished = false;
  return {
    segment(stage, run) {
      const segmentStarted = telemetryNow();
      try {
        return run();
      } finally {
        segments.push({ stage, durationMs: telemetryNow() - segmentStarted });
      }
    },
    push(stage, durationMs) {
      if (!Number.isFinite(durationMs)) return;
      segments.push({ stage, durationMs: Math.max(0, durationMs) });
    },
    finish(result = "success", endedAt) {
      if (finished) return;
      finished = true;
      const totalMs = Math.max(0, (endedAt ?? telemetryNow()) - started);
      emitPerf("perf.interaction", totalMs, { kind }, result);
      for (const segment of segments) emitPerf("perf.segment", segment.durationMs, { kind, stage: segment.stage }, result);
    }
  };
}
