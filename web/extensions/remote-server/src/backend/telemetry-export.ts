/**
 * 遥测上报出口：把本机遥测映射到 `woohaa.telemetry.v1alpha1.TelemetryService.ReportEvents`
 * （change: 2026-10-20-add-local-client-telemetry，tasks 7.3/7.4）。
 *
 * 为什么出口住在这里而不是 core：目标是**这台服务端**，凭据是**这份会话**。core 只回答"发不发"
 * （`telemetry.export.enabled`），发到哪由扩展自己的部署配置与会话决定——core 里没有任何
 * 目的地设置，所以也不会出现"配了 id 却没人读"的死控件。
 *
 * 有损映射（改 `telemetry.proto` 之前必须接受）：
 * - `durationMs` / `errorCode` / `attributes` **丢弃**：proto 没有这些字段。
 * - `task.terminal` **跳过**：`Action` 里没有对应枚举，硬塞一个别的值会让服务端计数撒谎。
 *
 * 投递语义是**宁可丢、不重复**：proto 没有幂等键，重试会让每个计数翻倍，而计数正是这条通道
 * 唯一的产出。因此失败只回错误码、不重试，也不在本地留待发队列。
 */
import type {
  TelemetryEvent,
  TelemetryExport,
  TelemetryEventName,
  TelemetryOrigin,
  TelemetryResult,
  TelemetrySurface
} from "@woohaa3/contracts";
import { callConnect } from "./connect.js";
import type { RemoteSessionSource } from "./session.js";
import { connectProcedurePath } from "../shared.js";

export const REMOTE_TELEMETRY_EXPORT_ID = "remote";

const TELEMETRY_SERVICE = "woohaa.telemetry.v1alpha1.TelemetryService";
/** 与 proto 注释一致：一次最多 100 条、16 KiB。两个上限同时生效。 */
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 16 * 1024;

/** 事件名 → proto `Action`；`null` 表示该事件在目标契约里没有对应值（跳过）。 */
const ACTION_BY_NAME: Readonly<Record<TelemetryEventName, string | null>> = {
  "canvas.open": "ACTION_CANVAS_OPEN",
  "canvas.save": "ACTION_CANVAS_SAVE",
  "canvas.edit": "ACTION_EDITOR_EDIT",
  "sync.connect": "ACTION_SYNC_CONNECT",
  "sync.reconcile": "ACTION_SYNC_RECONCILE",
  "local.validation": "ACTION_LOCAL_VALIDATION",
  "task.terminal": null
};

const RESULT_BY_VALUE: Readonly<Record<TelemetryResult, string>> = {
  success: "RESULT_SUCCESS",
  failure: "RESULT_FAILURE",
  cancelled: "RESULT_CANCELLED",
  rejected: "RESULT_REJECTED"
};

const CLIENT_BY_ORIGIN: Readonly<Record<TelemetryOrigin, string>> = {
  browser: "CLIENT_BROWSER",
  desktop: "CLIENT_DESKTOP",
  "local-host": "CLIENT_LOCAL_HOST"
};

/** proto 的 `Surface` 只有四个值；`task` 没有对应项。 */
const SURFACE_BY_VALUE: Readonly<Record<TelemetrySurface, string | null>> = {
  canvas: "SURFACE_CANVAS",
  editor: "SURFACE_EDITOR",
  sync: "SURFACE_SYNC",
  "local-validation": "SURFACE_LOCAL_VALIDATION",
  task: null
};

/**
 * 按事件名推导的 `Surface` 兜底。
 *
 * **必须兜底**：服务端 `CleanEvent` 要求 `surface` 落在 1..4，缺省值 0 会让**整批**被
 * `invalid_argument` 拒绝（不是"丢掉这一条"）。所以只要事件被映射，就一定要带一个合法 surface；
 * 本地事件没声明 `surface` 时，名称本身就隐含了它发生的面。
 */
const SURFACE_BY_NAME: Readonly<Record<TelemetryEventName, string | null>> = {
  "canvas.open": "SURFACE_CANVAS",
  "canvas.save": "SURFACE_CANVAS",
  "canvas.edit": "SURFACE_EDITOR",
  "sync.connect": "SURFACE_SYNC",
  "sync.reconcile": "SURFACE_SYNC",
  "local.validation": "SURFACE_LOCAL_VALIDATION",
  "task.terminal": null
};

/** 一条本机事件 → Connect JSON 的 `ClientEvent`；无对应枚举时返回 `null`。 */
export function toClientEvent(event: TelemetryEvent): Record<string, unknown> | null {
  const action = ACTION_BY_NAME[event.name];
  if (!action) return null;
  // surface 是**必填**：服务端缺省会整批拒绝（见 SURFACE_BY_NAME 注释），所以这里总有值。
  const surface =
    (event.surface === undefined ? null : SURFACE_BY_VALUE[event.surface]) ?? SURFACE_BY_NAME[event.name] ?? "SURFACE_CANVAS";
  return {
    action,
    result: RESULT_BY_VALUE[event.result],
    client: CLIENT_BY_ORIGIN[event.origin],
    surface,
    // 省略零值：proto3 JSON 里空串等价于"没声明"，写进去只是噪音。
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.frontendVersion ? { frontendVersion: event.frontendVersion } : {})
  };
}

/** 按条数与字节数同时切批；单条就超预算时仍然单独发（服务端会拒绝并被计为失败）。 */
export function splitClientEvents(events: readonly Record<string, unknown>[]): Array<Array<Record<string, unknown>>> {
  const batches: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (current.length > 0 && (current.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 日志面：只声明本模块真正会写的字段。
 *
 * 刻意不用 `Record<string, unknown>`——扩展主文件的 `RemoteLogInput` 没有索引签名，
 * 而且「能装任意键」正是把凭据写进日志的入口（那里的注释也是这个理由）。
 */
export type RemoteTelemetryExportLog = (event: {
  event: string;
  level?: "info" | "warn" | "error";
  code?: string;
  reason?: string;
  status?: number;
  acceptedCount?: number;
  serverUrl?: string;
}) => void;

export type RemoteTelemetryExportDeps = {
  sessionSource: Pick<RemoteSessionSource, "current">;
  fetchImpl: typeof globalThis.fetch;
  /** 结构化日志（与扩展其它部分同一 sink）。 */
  log: RemoteTelemetryExportLog;
};

/**
 * 创建 `remote` 出口。
 *
 * `available` 恒为 true：注册进来就表示"愿意尝试"，会话可以稍后才出现（用户先开开关后登录）。
 * 真正没有会话时由 `send` 回 `unconfigured` 并计入该出口的丢弃数，界面上能看见"开着但没连"。
 */
export function createRemoteTelemetryExport(deps: RemoteTelemetryExportDeps): TelemetryExport {
  // 同一错误码只记一次：出口是每批都被调用的，重复日志会把宿主日志刷满。
  let lastLoggedCode: string | undefined;
  const logFailure = (code: string, extra: { status?: number; acceptedCount?: number; reason?: string } = {}) => {
    if (lastLoggedCode === code) return;
    lastLoggedCode = code;
    deps.log({ event: "remote-telemetry-export-failed", level: "warn", code, ...extra });
  };

  return {
    exportId: REMOTE_TELEMETRY_EXPORT_ID,
    label: "服务端接入",
    available: true,
    async send(batch: readonly TelemetryEvent[]) {
      const mapped = batch.map(toClientEvent).filter((event): event is Record<string, unknown> => event !== null);
      // 整批都映射不了（例如只有 task.terminal）不算失败：没有可发的东西而已。
      if (mapped.length === 0) return { ok: true, accepted: 0 };

      const session = await deps.sessionSource.current();
      if (!session) {
        logFailure("unconfigured");
        return { ok: false, code: "unconfigured", message: "未连接服务端" };
      }

      let accepted = 0;
      for (const chunk of splitClientEvents(mapped)) {
        // 不重试：proto 无幂等键，重投会让计数翻倍（见文件头注释）。
        const result = await callConnect<{ acceptedCount?: number }>(
          deps.fetchImpl,
          session.serverUrl,
          connectProcedurePath(TELEMETRY_SERVICE, "ReportEvents"),
          { events: chunk },
          { token: session.token }
        );
        if (!result.ok) {
          // 404/501/`unimplemented` = 这台服务端还没有这个接口：给一句可行动的话。
          const unimplemented = result.code === "unimplemented" || result.status === 404 || result.status === 501;
          const code = unimplemented ? "unimplemented" : result.code;
          logFailure(code, { status: result.status, ...(accepted > 0 ? { acceptedCount: accepted } : {}) });
          return { ok: false, code, message: unimplemented ? "服务端尚未实现遥测上报接口" : result.message };
        }
        // proto3 JSON 省略零值：`{}` 就是"新增 0 条"，缺失按 0 处理。
        accepted += result.value?.acceptedCount ?? 0;
      }

      lastLoggedCode = undefined;
      deps.log({ event: "remote-telemetry-export-ok", acceptedCount: accepted, serverUrl: session.serverUrl });
      return { ok: true, accepted };
    }
  };
}
