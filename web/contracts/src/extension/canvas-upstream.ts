/**
 * 画布同步上游凭据提供者 capability 契约（纯类型；宿主与扩展共享）。
 *
 * 背景：登录远端需要扩展（例如 `remote-server`）去换会话；宿主不需要知道具体扩展，
 * 只需要「怎么连中继」。两者之间缺一个交接面：扩展知道「接哪台、用什么令牌」，
 * 宿主知道「怎么连中继」。静态 `canvas.syncUpstream.*` 已移除，这里是唯一的上游来源。
 *
 * 这里定义的就是那个交接面，形态刻意与 `canvas-source:<id>` 一致：
 * - 扩展注册 `canvas-upstream:<providerId>` capability；
 * - 宿主按**声明**解析，不认识具体扩展 id（不写死 `remote-server`）；
 * - 返回值只交给本机宿主进程，**令牌永远不进浏览器**（边界 B1/B3）。
 *
 * 提供者不可用、配置缺失或形态非法时画布保持纯本地，不得因此让画布失去编辑与保存能力——
 * 「没接远端」是一种正常形态。
 *
 * **同步是按画布的显式决定，不是登录的默认后果**。接入远端（例如登录 `remote-server`）
 * 只代表「远端可用」；某张本地画布要不要上传到服务端，由用户在该画布上显式操作。因此
 * capability 的解析入口按 `canvasId` 逐个回答，而不是给出一份全局凭据：
 * - 画布已在远端（远端目录里有这个 id）→ 返回链路参数；
 * - 画布只在本地、用户还没显式启用同步 → 返回 `null`，画布保持纯本地；
 * - 会话失效 / 未登录 → 返回 `null`。
 *
 * 这条约束是数据边界而不是 UI 偏好：返回非空就意味着这张画布的内容会进入远端中继，
 * 提供者不得用「已登录」代替「用户同意同步这张画布」。
 */

import type { CanvasAccess } from "../canvas/catalog.js";

/** capability id 前缀。 */
export const CANVAS_UPSTREAM_CAPABILITY_PREFIX = "canvas-upstream:";

export function canvasUpstreamCapabilityId(providerId: string): string {
  return `${CANVAS_UPSTREAM_CAPABILITY_PREFIX}${providerId}`;
}

export function isCanvasUpstreamCapabilityId(value: string): boolean {
  return value.startsWith(CANVAS_UPSTREAM_CAPABILITY_PREFIX) && value.length > CANVAS_UPSTREAM_CAPABILITY_PREFIX.length;
}

export function canvasUpstreamProviderIdFromCapabilityId(capabilityId: string): string | null {
  return isCanvasUpstreamCapabilityId(capabilityId) ? capabilityId.slice(CANVAS_UPSTREAM_CAPABILITY_PREFIX.length) : null;
}

/** 一次解析的结果：要么给出上游连接参数，要么明确「这次不接管」。 */
export type CanvasUpstreamLink = {
  /** 中继 ws(s) 基址（已规范化，不带尾斜杠）。 */
  url: string;
  /** 会话令牌。**只存在于本机宿主进程**；不得进入日志、诊断或任何响应体。 */
  token: string;
};

/**
 * 扩展提供给宿主的同步上游。
 *
 * `resolve(canvasId)` 每次连接（以及运行中每次重新解析）都会调用（不缓存结论）：会话可能
 * 过期、地址可能被改、某张画布的同步意图也可能变。返回 `null` 表示「这张画布当前不走
 * 这个来源」，宿主回落到静态配置。
 *
 * 实现必须**不得**抛错代替返回 `null`（宿主会容错，但静默失败更难排查）；
 * 真要报告原因时用 `describe()` 给运维读，那个结果不会进浏览器。
 */
export type CanvasUpstreamProvider = {
  /** 稳定 id（与 capability id 后缀一致）。 */
  providerId: string;
  /**
   * 为**这一张画布**解析上游链路。
   *
   * 宿主对每个加载中的 room 分别调用；`null` 是该画布的缺省答案（不同步）。实现不得
   * 用「有会话」直接代替「这张画布已被同意同步」。
   */
  resolve(canvasId: string): Promise<CanvasUpstreamLink | null>;
  /** 面向运维的一句话状态（不含令牌）；宿主只用于日志与诊断。 */
  describe?(): string;
  /**
   * 该来源当前可见的画布摘要（可选）。
   *
   * 与 `resolve` 是**同一份接入的两个面**：一个管内容同步，一个管目录。提供时宿主把
   * 它作为追加来源并入本机目录——本地新建的与远端已有的出现在同一份列表里，同一个
   * id 只出现一次。不提供则该来源对目录不可见（只影响内容同步）。
   *
   * 失败时必须返回空数组而不是抛错：目录是"有哪些画布"，一个来源故障不该让整份
   * 列表消失。原因写进 `describe()`。
   */
  listCanvases?(): Promise<readonly CanvasRemoteSummary[]>;
  /**
   * 按 id 取一张**不在我的目录里**的远端画布摘要（可选）。
   *
   * 这是「链接打开」的入口：拿到分享链接的已认证用户按 id 打开一张画布时，它不会出现在
   * `listCanvases` 里（链接不让画布进入对方目录），宿主需要一份摘要才能把目录条目补出来、
   * 并从上游拉内容。取不到时（没有这张画布、当前主体不可见、会话失效、远端故障）返回
   * `null`——**不得抛错**，失败口径与 `listCanvases` 一致。
   *
   * 实现若因这次按 id 的访问认定「这张画布可以走本来源同步」，由实现自己记住这个事实
   * （例如并入显式同步意图并持久化）；宿主只把摘要用于目录展示与打开，不代替实现做同步决定。
   */
  getCanvas?(canvasId: string): Promise<CanvasRemoteSummary | null>;
  /**
   * 按 id 回答调用者在这张画布上的内容权限（可选）。
   *
   * 与 `getCanvas` 的区别是**被拒绝也是答案**：远端明确拒绝时返回
   * `{ canRead: false, canWrite: false }`，而 `getCanvas` 只能返回 null（"取不到"）。
   * 返回 `null` 表示这次没有答案（未登录、来源不可用、远端故障），调用方按"未知"处理，
   * 不得据此把画布判成只读。
   *
   * 宿主在打开画布时读它：没有权限的提示必须出现在**进入画布**这一步，而不是等第一次
   * 服务端写入（生成/存储）被拒绝才暴露。
   */
  access?(canvasId: string): Promise<CanvasAccess | null>;
};

/** 远端来源能提供的画布摘要（字段最小化；缺的由宿主补默认值）。 */
export type CanvasRemoteSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  createdAt?: string;
  nodeCount?: number;
  assetCount?: number;
  /** 调用者在这张画布上的内容权限；省略表示来源没有给答案。 */
  access?: CanvasAccess;
};

export function isCanvasUpstreamProviderShape(value: unknown): value is CanvasUpstreamProvider {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerId === "string" &&
    record.providerId !== "" &&
    typeof record.resolve === "function" &&
    (record.describe === undefined || typeof record.describe === "function") &&
    (record.listCanvases === undefined || typeof record.listCanvases === "function") &&
    (record.getCanvas === undefined || typeof record.getCanvas === "function")
  );
}

/** 读取同步上游时宿主用的最小 settings 形状（避免 contracts 依赖具体实现）。 */
export type UpstreamSettingsReader = { get(key: string): unknown };
