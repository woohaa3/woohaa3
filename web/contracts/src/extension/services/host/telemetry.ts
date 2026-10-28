/**
 * `ctx.telemetry` 与遥测扩展点契约（change: 2026-10-20-add-local-client-telemetry，design D2/D8）。
 *
 * 分工只有一条分界线：**core 拥有事实，出口只负责搬运。**
 *
 * - core（`ctx.telemetry`）拥有：事件形状与白名单、本地存储、保留、查询、聚合、异常规则。
 * - 出口（`TelemetryExport`，站点扩展注册）拥有：把一批事件送到某个目的地，自己决定节流与
 *   凭据。出口不拥有事件形状，也不能让 core 依赖它是否就绪。
 *
 * 为什么本地记录不做成出口：出口缺失时事件会**无声消失**，而"事后复盘"恰恰不能有这种空窗。
 * 相反，出口是"可增删的目的地"，正好是扩展点的语义——这也是它与 `ctx.generation`（fan-in
 * 注册表）同形、与 `ctx.storage`（单选 primary）不同形的原因。
 */
import type { TelemetryEvent, TelemetryEventInput } from "../../../telemetry/event.js";
import type {
  TelemetryAnomaly,
  TelemetryBucket,
  TelemetryEventFilter,
  TelemetryEventPage,
  TelemetryStatus,
  TelemetrySummary,
  TelemetryWindow
} from "../../../telemetry/query.js";
import type { TelemetryAttributeKey } from "../../../telemetry/event.js";

/**
 * 一次投递的结果。
 *
 * `ok: false` 不是异常：出口失败是本机遥测的正常分支，core 只记日志与丢弃计数。
 * `code` 必须是稳定短标识（不是错误消息），便于页面按类别聚合并避免把远端正文带进本机。
 */
export type TelemetryExportResult =
  | { readonly ok: true; readonly accepted?: number }
  | { readonly ok: false; readonly code: string; readonly message?: string };

/** 一个遥测出口（站点扩展注册）。 */
export type TelemetryExport = {
  /**
   * 出口的短标识，只用于**日志、状态面与去重**，不是"选择开关"。
   *
   * core 不按它挑选目的地：`telemetry.export.enabled` 打开时，所有自述可用的出口都会收到事件；
   * 「发到哪、用什么凭据」由出口自己的配置段决定（例如服务端接入扩展的部署地址与登录）。
   * 这样 core 既不需要枚举出口，也不会出现"配了 id 却没人读"的死设置。
   *
   * 与扩展 identity 解耦：先例是 `local-storage` 扩展提供 `backendId = "local"`；core 里不得
   * 出现任何扩展 id 字面量（`extension-purity` 门禁）。
   */
  readonly exportId: string;
  /** 设置页与日志里的显示名。 */
  readonly label?: string;
  /** 当前是否可发（未登录、缺配置 → false）；缺省视为可用。 */
  readonly available?: boolean;
  /**
   * 送出一批事件。
   *
   * 允许抛错或返回失败；core 一律吞掉并计入该出口的丢弃数。实现不得假设 core 会重试——
   * 目标契约没有幂等键时重试会让计数翻倍，而计数正是这条通道唯一的产出。
   */
  send(batch: readonly TelemetryEvent[]): Promise<TelemetryExportResult> | TelemetryExportResult;
};

/**
 * 分组读取的可选口径（`summary` / `anomalies` 共用）。
 *
 * `attributeKey` + `attributeValue` 是**筛选**：只在该属性取值相等的事件上聚合。它是 spec
 * 「按 production 筛选的耗时分布不包含 dev 样本」的落点——不能靠界面隐藏行来假装分开。
 */
export type TelemetryReadOptions = {
  /** 单键分组；缺省按事件名聚合。 */
  readonly groupBy?: TelemetryAttributeKey;
  /** 与 `attributeValue` 成对出现的属性精确匹配；只给其一由路由层拒绝。 */
  readonly attributeKey?: TelemetryAttributeKey;
  readonly attributeValue?: string;
};

/**
 * `ctx.telemetry`：采集、查询与复盘入口。
 *
 * 与 `ctx.generation` / `ctx.storage` 同形的注册面（`register`/`unregister`/`list`/`resolve`），
 * 但**没有** `primaryId`/`exposeId`/`readiness`：遥测不是"选一个目的地"，而是"本地一定记，
 * 出口可以有零到多个"；它也**不参与启动就绪**（存储坏了业务仍必须可用）。
 */
export type HostTelemetryService = {
  /**
   * 发一条事实。同步入队后立即返回，**绝不抛错、绝不阻塞**。
   *
   * 非法输入被丢弃并计入 `droppedInvalid`；队列满时丢最旧并计入 `droppedOverflow`。调用点
   * 可以无脑调用，不需要 try/catch，也不需要等待。
   */
  emit(input: TelemetryEventInput): void;

  /** 事件列表：最新在前、游标分页。 */
  query(filter?: TelemetryEventFilter): Promise<TelemetryEventPage>;

  /**
   * 窗口聚合：每个事件名的计数/结果分布/分位数/高频错误码，外加时间序列。
   *
   * `options.groupBy` 给出时行变成「事件名 × 属性值」组，返回的 `TelemetrySummary.groupBy` 会带上
   * 该键；分组行的计数与分位数只统计组内样本。`options.attributeKey/attributeValue` 是筛选，
   * 用来把不同构建模式的样本分开算（spec：按 `production` 筛选的分布不含 dev 样本）。
   * 详见 change: 2026-10-25-enhance-telemetry-performance-collection，design D5。
   */
  summary(window: TelemetryWindow, bucket?: TelemetryBucket, options?: TelemetryReadOptions): Promise<TelemetrySummary>;

  /** 当前窗口命中的异常（确定性规则，见 design D6）；`groupBy` 让规则按输入种类/阶段分组。 */
  anomalies(window: TelemetryWindow, options?: TelemetryReadOptions): Promise<readonly TelemetryAnomaly[]>;

  /** 注册一个出口；返回注销函数（站点扩展放进自己的回滚路径）。 */
  registerExport(provider: TelemetryExport): () => void;
  unregisterExport(exportId: string): void;
  listExports(): readonly TelemetryExport[];

  /** 复盘页与设置面用的只读状态快照。 */
  status(): Promise<TelemetryStatus>;

  /** 清空本地记录（保留期之外的清理不受影响）；返回删除条数。 */
  clear(): Promise<number>;

  /** 把队列里的事件写盘。测试与进程退出时用；业务路径不应等待它。 */
  flush(): Promise<void>;

  /** 关闭存储与定时器；由宿主 effect 在卸载时调用。 */
  close(): void;
};
