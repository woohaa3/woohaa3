/**
 * 基础层 · diagnostics：服务端接入相关的诊断事件，有界内存缓冲。
 *
 * 为什么要有它：接入远端服务端之后，「连没连上、卡在哪一步、同步为什么掉线」这些事实
 * 分散在**本机宿主**里（remote-server 扩展的登录/探测、canvas-service 的同步上游事件）。
 * 浏览器只拿得到状态快照，看不到过程；宿主日志又只落磁盘。这个缓冲把两者投影成一份
 * 浏览器可读、可上报的有界事件流。
 *
 * 三条硬约束：
 * 1. **只收白名单事件**：`remote-server` 扩展的事件与画布同步上游的 `sync-upstream-*`；
 *    其它模块的日志一律不进缓冲（不是「先收全部再过滤」）。
 * 2. **只投影白名单字段**：时间、级别、模块、事件名、稳定错误码、短说明与有界键值细节。
 *    原始日志行里的任意字段（请求头、URL query、设备码、令牌、会话主体等）不会进入条目。
 * 3. **有界**：固定容量环形缓冲，写满即丢最旧条目；读取也有条数上限。诊断不能成为内存泄口。
 *
 * 本模块不读磁盘、不跨进程、不持久化：诊断是运行期排障信息，不是审计账本。
 */
import { randomUUID } from "node:crypto";
import { redactLogText, type ApplicationBackendDiagnosticEntry } from "@woohaa3/contracts";
import type { HostDiagnosticsService, HostPlugin } from "../context.js";

/** 缓冲容量：够看出一次接入流程，又不至于把历史日志堆在内存里。 */
export const MAX_DIAGNOSTIC_ENTRIES = 500;
/** 单条说明的字符上限（与上报契约一致）。 */
export const MAX_DIAGNOSTIC_MESSAGE = 512;
/** 单个属性值的字符上限（与上报契约一致：值单行 ≤256 字符）。 */
export const MAX_DIAGNOSTIC_ATTRIBUTE_VALUE = 256;
/** 条目属性对数上限（与上报契约一致：≤16 对）；本投影最多产出 7 对，这里为未来新增留余量。 */
export const MAX_DIAGNOSTIC_ATTRIBUTES = 16;
/** `snapshot()` 的缺省条数与硬上限。 */
const DEFAULT_SNAPSHOT_LIMIT = 200;
const MAX_SNAPSHOT_LIMIT = MAX_DIAGNOSTIC_ENTRIES;

const SAFE_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const SAFE_CONFIG_KEY = /^[a-z][a-z0-9.-]{0,63}$/;
const SAFE_HOST = /^[A-Za-z0-9.-]{1,255}(?::\d{1,5})?$/;
const LEVELS = new Set(["debug", "info", "warn", "error"]);

/**
 * 诊断属性的键。
 *
 * 契约把键的形状锁成 `[a-z][a-z0-9._-]{0,31}`，而管理端按这些键展示与检索，所以键名必须在
 * 这里固定成常量——不能由事件字段现拼。改名等于改展示口径，得显式改这里而不是「顺手」
 * 传什么就写什么。
 */
const ATTRIBUTE_KEYS = {
  status: "status",
  server: "server",
  method: "method",
  backend: "backend",
  phase: "phase",
  invalid: "invalid",
  missing: "missing"
} as const;

function readString(event: Record<string, unknown>, key: string): string | null {
  const value = event[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readLevel(value: unknown): ApplicationBackendDiagnosticEntry["level"] {
  return typeof value === "string" && LEVELS.has(value) ? (value as ApplicationBackendDiagnosticEntry["level"]) : "info";
}

/**
 * 说明文本的清洗：控制字符与换行一律折叠成空格；令牌式片段脱敏；超长截断。
 *
 * 这不是「尽力而为的过滤」而是**进入缓冲前的唯一入口**：任何原始字段都必须经过它才能
 * 变成可展示文本。即便如此，调用方也不该把凭据写进日志——两层都要成立。
 */
export function sanitizeDiagnosticText(value: unknown, limit = MAX_DIAGNOSTIC_MESSAGE): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  // 脱敏规则只有一份（contracts 的 `redactLogText`）：这里不再自己维护一张正则表，
  // 否则宿主日志出口与诊断缓冲会各写一份、逐渐漂移。上限由调用方传入。
  const redacted = redactLogText(value, limit);
  return redacted === "" ? undefined : redacted;
}

/** 只接受本机宿主里「对接服务端」那几条链路的日志。 */
function isServerIntegrationEvent(category: string, event: Record<string, unknown>, name: string): boolean {
  if (category === "application") {
    // 站点扩展的日志由 application-service 加上 extensionId 后交给宿主 logger。
    return event.extensionId === "remote-server";
  }
  if (category === "canvas") {
    return name.startsWith("sync-upstream-") || name === "canvas-sync-upstream";
  }
  return false;
}

/**
 * 把事件里的结构化细节投影成 `attributes`。
 *
 * 每个值与 `message` 走同一条清洗（控制字符折叠、令牌式脱敏、超长截断），只是上限收紧到
 * 契约的 256 字符；形状不合法的字段整对丢弃——它们只是解释性细节，丢一对不影响条目本身，
 * 也绝不放宽形状去「保住」它们。没有任何合法细节时返回 undefined，让调用方省略这个键
 * （与 `code` / `message` 的省略风格一致）。
 *
 * 为什么不再拼进 message：管理端要按这些键展示与检索，拼成一句话就只剩人眼可读、
 * 机器不可检索的文本；键名固定（见 `ATTRIBUTE_KEYS`），值仍受既有正则与上限约束。
 */
function projectDiagnosticAttributes(event: Record<string, unknown>): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  let count = 0;
  const put = (key: string, value: string): void => {
    // 契约只接受 ≤16 对；这里防御性封顶，避免未来新增细节时悄悄超限。
    if (count >= MAX_DIAGNOSTIC_ATTRIBUTES) return;
    const sanitized = sanitizeDiagnosticText(value, MAX_DIAGNOSTIC_ATTRIBUTE_VALUE);
    if (sanitized === undefined) return;
    attributes[key] = sanitized;
    count += 1;
  };

  const status = event.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 999) {
    put(ATTRIBUTE_KEYS.status, String(status));
  }
  const serverHost = readString(event, "serverHost");
  if (serverHost && SAFE_HOST.test(serverHost)) put(ATTRIBUTE_KEYS.server, serverHost);
  const method = readString(event, "method");
  if (method && SAFE_IDENTIFIER.test(method)) put(ATTRIBUTE_KEYS.method, method);
  const backendId = readString(event, "backendId");
  if (backendId && SAFE_IDENTIFIER.test(backendId)) put(ATTRIBUTE_KEYS.backend, backendId);
  const phase = readString(event, "phase");
  if (phase && SAFE_IDENTIFIER.test(phase)) put(ATTRIBUTE_KEYS.phase, phase);
  const invalid = readString(event, "invalid");
  if (invalid && SAFE_CONFIG_KEY.test(invalid)) put(ATTRIBUTE_KEYS.invalid, invalid);
  if (Array.isArray(event.missing)) {
    const missing = event.missing.filter((value): value is string => typeof value === "string" && SAFE_CONFIG_KEY.test(value));
    // missing 保持最多 8 项、逗号连接：再多对排障没有增量，只会把值撑到上限。
    if (missing.length > 0) put(ATTRIBUTE_KEYS.missing, missing.slice(0, 8).join(","));
  }

  return count > 0 ? attributes : undefined;
}

/**
 * 把一条宿主日志投影成诊断条目；不属于白名单或形状不合法时返回 null。
 *
 * `message` 只保留人类可读主文本（`message`/`reason` 清洗后的结果），细节全部进
 * `attributes`；只有细节没有主文本时 `message` 缺省，`attributes` 照常存在。
 */
export function projectHostLogEvent(
  event: Record<string, unknown>
): Omit<ApplicationBackendDiagnosticEntry, "id" | "seq" | "time"> | null {
  const category = readString(event, "module");
  const name = readString(event, "event");
  if (!category || !name) return null;
  if (!SAFE_IDENTIFIER.test(category) || !SAFE_IDENTIFIER.test(name)) return null;
  if (!isServerIntegrationEvent(category, event, name)) return null;

  const codeRaw = readString(event, "code");
  const code = codeRaw && SAFE_CODE.test(codeRaw) ? codeRaw : undefined;

  const message = sanitizeDiagnosticText(readString(event, "message") ?? readString(event, "reason"));
  const attributes = projectDiagnosticAttributes(event);

  return {
    level: readLevel(event.level),
    category,
    event: name,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(attributes ? { attributes } : {})
  };
}

export type HostDiagnosticsOptions = {
  capacity?: number;
  now?: () => number;
  /**
   * 条目 id 的生成器，缺省 `crypto.randomUUID`。
   *
   * id 必须**在记录那一刻**生成并固定：它是上报的幂等键，重复上报同一条目时服务端靠它
   * 去重。测试注入固定序列，才能断言"同一条目被上报两次"这条行为。
   */
  newId?: () => string;
};

/** 创建有界诊断缓冲；写入只接受白名单投影，读取返回副本。 */
export function createHostDiagnostics(options: HostDiagnosticsOptions = {}): HostDiagnosticsService {
  const capacity = Math.max(1, Math.trunc(options.capacity ?? MAX_DIAGNOSTIC_ENTRIES));
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? randomUUID;
  const entries: ApplicationBackendDiagnosticEntry[] = [];
  let nextSeq = 1;

  return {
    capacity,
    record(event) {
      const projected = projectHostLogEvent(event);
      if (!projected) return;
      entries.push({ id: newId(), seq: nextSeq, time: now(), ...projected });
      nextSeq += 1;
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    snapshot(input = {}) {
      const since = typeof input.since === "number" && Number.isFinite(input.since) ? Math.trunc(input.since) : 0;
      const requested = typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.trunc(input.limit) : DEFAULT_SNAPSHOT_LIMIT;
      const limit = Math.min(MAX_SNAPSHOT_LIMIT, Math.max(1, requested));
      const filtered = since > 0 ? entries.filter((entry) => entry.seq > since) : entries;
      return filtered.slice(-limit).map((entry) => ({ ...entry }));
    }
  };
}

export const diagnosticsPlugin: HostPlugin = {
  name: "diagnostics",
  apply(ctx) {
    ctx.provide("diagnostics", createHostDiagnostics());
  }
};
