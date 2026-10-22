/**
 * 本机遥测复盘页的 URL 查询白名单编解码
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.1 / design D9）。
 *
 * 三条口径：
 * - **只放有界枚举与不透明游标**：`window`（四档）/`name`（事件名白名单）/`result`（四值）/
 *   `cursor`（opaque，宿主生成）/`eventId`（选中详情）。事件属性、错误消息、prompt 之类一律
 *   不进入 URL——链接会被复制给别人，它只该表达"我筛了什么"，不该携带任何数据本身。
 * - **非法值规范化丢弃**：URL 是用户可编辑的输入，未知窗口/事件名/结果静默丢弃并落回缺省，
 *   而不是抛错让整页不可用（同 `pages/task-monitor/query.ts` 的取向）。
 * - **筛选变更必须重置游标**：换窗口/换事件名/换结果/换错误码后，旧游标指向另一份结果集，
 *   继续沿用会得到"筛了但列表还是旧的"的自相矛盾（`patchTelemetryQuery` 负责）。
 */
import {
  TELEMETRY_CURSOR_MAX_LENGTH,
  isTelemetryEventName,
  isTelemetryResult,
  isTelemetryWindow,
  type TelemetryEventName,
  type TelemetryResult,
  type TelemetryWindow
} from "@woohaa3/contracts";

/** 缺省窗口：24 小时（与 design D5 的「一天」口径一致，既够看一天又不会一屏塞满）。 */
export const DEFAULT_TELEMETRY_WINDOW: TelemetryWindow = "24h";

/** 游标是不透明串，只做长度/字符集兜底（宿主生成的 id 目前是十进制数）。 */
const CURSOR_PATTERN = new RegExp(`^[0-9A-Za-z_-]{1,${TELEMETRY_CURSOR_MAX_LENGTH}}$`);
const RECORD_ID_PATTERN = /^[0-9]{1,19}$/;
/** 画布标识：不透明，只做字符集与长度兜底（与 task-history 的 `boundedId` 同取向）。 */
const CANVAS_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 复盘页的已应用查询。
 *
 * `errorCode` **不在**这里：它有 64 字符的稳定错误码形状，取值空间来自运行时，放进 URL 会让
 * "链接里出现业务细节"，因此只做页面内筛选（`TelemetryPageProps.errorCode`）。
 *
 * `canvasId` **不是筛选**：它是"从哪张画布来的"，唯一用途是让「返回画布」回到原来那张，
 * 而不是落到默认空画布。因此筛选变化时**不清除**它，也不算 `hasTelemetryFilters`。
 */
export type TelemetryQuery = {
  readonly window: TelemetryWindow;
  readonly name?: TelemetryEventName;
  readonly result?: TelemetryResult;
  readonly cursor?: string;
  readonly eventId?: string;
  readonly canvasId?: string;
};

/** 筛选补丁：`""` 表示"取消该筛选"，与"未提供"区分开。 */
export type TelemetryQueryPatch = {
  readonly window?: TelemetryWindow;
  readonly name?: TelemetryEventName | "";
  readonly result?: TelemetryResult | "";
  readonly cursor?: string;
  readonly eventId?: string;
};

/** 页面本地筛选（不进 URL）；只含错误码一项。 */
export type TelemetryLocalFilter = {
  readonly errorCode?: string;
};

/** 从 URLSearchParams 解码；未知键忽略，非法值丢弃。 */
export function decodeTelemetrySearch(search: URLSearchParams): TelemetryQuery {
  const window = search.get("window");
  const name = search.get("name");
  const result = search.get("result");
  const cursor = search.get("cursor");
  const eventId = search.get("eventId");
  const canvasId = search.get("canvasId");
  return {
    window: isTelemetryWindow(window) ? window : DEFAULT_TELEMETRY_WINDOW,
    ...(isTelemetryEventName(name) ? { name } : {}),
    ...(isTelemetryResult(result) ? { result } : {}),
    ...(cursor && CURSOR_PATTERN.test(cursor) ? { cursor } : {}),
    ...(eventId && RECORD_ID_PATTERN.test(eventId) ? { eventId } : {}),
    ...(canvasId && CANVAS_ID_PATTERN.test(canvasId) ? { canvasId } : {})
  };
}

/** 编码为规范 URLSearchParams（稳定顺序；缺省窗口也写入，便于分享完整口径）。 */
export function encodeTelemetrySearch(query: TelemetryQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("window", query.window);
  if (query.name) params.set("name", query.name);
  if (query.result) params.set("result", query.result);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.eventId) params.set("eventId", query.eventId);
  // 返回目标是"路由上下文"，跟着链接一起走：刷新或转发后仍能回到原来那张画布。
  if (query.canvasId) params.set("canvasId", query.canvasId);
  return params;
}

/** 编码为页面 location 的 `query` 记录（App Router 的通用承载形状）。 */
export function telemetryQueryToRecord(query: TelemetryQuery): Record<string, string> {
  return Object.fromEntries(encodeTelemetrySearch(query));
}

/** 应用补丁：任何筛选变化都清空游标；选中详情变化不重置游标。 */
export function patchTelemetryQuery(query: TelemetryQuery, patch: TelemetryQueryPatch): TelemetryQuery {
  const next: {
    -readonly [K in keyof TelemetryQuery]: TelemetryQuery[K];
  } = { window: patch.window ?? query.window };
  // 返回目标与筛选无关：任何筛选补丁都原样带过去，否则"筛一下就回不到原来那张画布"。
  if (query.canvasId) next.canvasId = query.canvasId;

  const name = patch.name === undefined ? query.name : patch.name;
  if (name) next.name = name;
  const result = patch.result === undefined ? query.result : patch.result;
  if (result) next.result = result;

  const filterChanged = patch.window !== undefined || patch.name !== undefined || patch.result !== undefined;
  const cursor = patch.cursor !== undefined ? patch.cursor : filterChanged ? undefined : query.cursor;
  if (cursor) next.cursor = cursor;
  // 筛选一变，旧选中项多半已不在结果集里，一并清掉，避免详情侧栏指向不存在的行。
  const eventId = patch.eventId !== undefined ? patch.eventId : filterChanged ? undefined : query.eventId;
  if (eventId) next.eventId = eventId;
  return next;
}

/** 是否有除窗口以外的筛选（空态文案据此区分"还没有记录"与"没有匹配条件"）。 */
export function hasTelemetryFilters(query: TelemetryQuery, local: TelemetryLocalFilter = {}): boolean {
  return Boolean(query.name || query.result || local.errorCode);
}

/** 规范化错误码输入：合法形状才接受，否则视为未填（不把非法值发到宿主）。 */
export function normalizeErrorCodeFilter(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(trimmed) ? trimmed : undefined;
}
