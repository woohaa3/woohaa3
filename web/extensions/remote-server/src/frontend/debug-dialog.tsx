/**
 * 「服务端接入日志」调试窗口（change: 2026-10-19-add-remote-server-extension）。
 *
 * 解决的问题：接入远端失败时，用户只能看到最终一句「连不上」，而具体是哪一步（探测 / 登录 /
 * 设备码 / 上游交接）失败、远端回了什么稳定错误码，全都散落在本机宿主日志里。这个窗口把宿主
 * **已经脱敏、有界**的诊断缓冲摆到界面上，让排查不必去翻宿主日志。
 *
 * 三条边界：
 * - 只读宿主缓冲，**不含令牌**、设备码、请求体或远端响应正文（shared.ts 的 DTO 本身就不带这些）；
 * - 宿主不支持诊断能力时必须明说「不可用」，不能渲染成一份空列表——「没有这个能力」和
 *   「最近没有事件」对排查者是两个相反的结论；
 * - 轮询只在本窗口打开时跑（1500ms），关闭即清理，且请求在途时不叠加。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { objectPayload } from "@woohaa3/frontend/extension-api";
import type { DialogDefinition, DialogRendererProps, DialogsService } from "@woohaa3/frontend/extension-api";
import type {
  RemoteDiagnosticEntry,
  RemoteDiagnosticsReadResult,
  RemoteDiagnosticsReportResult,
  RemoteDiagnosticsSnapshot,
  RemoteServerSnapshot
} from "../shared.js";
import "./remote-server.css";

export const REMOTE_SERVER_DEBUG_DIALOG_ID = "remote-server-debug";

/** 轮询间隔：够快看到「正在连接 → 已连接」，又不至于把宿主日志刷成噪声。 */
export const REMOTE_SERVER_DEBUG_POLL_INTERVAL_MS = 1500;

/** 调试窗口只需要读模型与两个诊断动作；用结构类型便于测试注入替身。 */
export type RemoteDebugDialogService = {
  getSnapshot(): RemoteServerSnapshot;
  subscribe(listener: () => void): () => void;
  api: {
    loadDiagnostics(): Promise<RemoteDiagnosticsReadResult>;
    reportDiagnostics(): Promise<RemoteDiagnosticsReportResult>;
  };
};

/**
 * Dialog definition：单例、可关闭、标准大尺寸。
 *
 * payload 只有空对象——窗口内容全部来自宿主读模型，不需要调用方传参；`objectPayload`
 * 让宿主在打开前就把「不是对象」的 payload 拒掉。
 */
export const remoteServerDebugDialogDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "lg",
  variant: "standard",
  validatePayload: objectPayload<Record<string, never>>(REMOTE_SERVER_DEBUG_DIALOG_ID, () => ({}))
};

const PHASE_LABEL: Record<RemoteServerSnapshot["phase"], string> = {
  local: "本地模式",
  connecting: "正在连接",
  connected: "已连接",
  error: "连接异常"
};

/** 本地时钟 `HH:mm:ss`。不用 `toLocaleTimeString`：它把格式交给 locale，日志对齐会跳。 */
export function formatDiagnosticClock(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 诊断属性的稳定展示顺序：按 key 升序。
 *
 * 界面行与「复制」文本共用这一个顺序：对象的插入序会随宿主实现漂移，若两处各排各的，
 * 复制出去的两条日志就无法对照着看。
 */
function sortedDiagnosticAttributes(entry: RemoteDiagnosticEntry): Array<[string, string]> {
  return Object.entries(entry.attributes ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** 单条事件的稳定文本形态（界面与「复制」共用，避免两处格式漂移）。 */
export function formatDiagnosticEntry(entry: RemoteDiagnosticEntry): string {
  return [
    formatDiagnosticClock(entry.time),
    entry.level.toUpperCase(),
    entry.category,
    entry.event,
    entry.code ?? "",
    entry.message ?? "",
    ...sortedDiagnosticAttributes(entry).map(([key, value]) => `${key}=${value}`)
  ]
    .filter((part) => part !== "")
    .join(" ");
}

export function formatDiagnosticsText(entries: readonly RemoteDiagnosticEntry[]): string {
  return entries.map(formatDiagnosticEntry).join("\n");
}

async function defaultCopyText(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("当前环境不支持剪贴板");
  await navigator.clipboard.writeText(text);
}

type LoadState = {
  /** 最近一次读成功的快照；读失败但已有旧数据时保留它并单独提示错误。 */
  snapshot: RemoteDiagnosticsSnapshot | null;
  error: string | null;
  loading: boolean;
};

export type RemoteServerDebugDialogProps = {
  service: RemoteDebugDialogService;
  /** 实例 id（用于 aria-labelledby）；独立渲染时给个稳定值即可。 */
  instanceId?: string;
  /** 关闭回调；不传时（独立渲染/测试）不渲染关闭动作。 */
  onClose?: () => void;
  /** 复制实现（测试注入；缺省用 `navigator.clipboard`）。 */
  copyText?: (text: string) => Promise<void>;
};

/**
 * 调试窗口主体。
 *
 * 单独导出而不只暴露 renderer：窗口可以在测试或其它宿主表面独立渲染，renderer 只是把它接到
 * Dialog Service 上的薄壳。
 */
export function RemoteServerDebugDialog({
  service,
  instanceId = REMOTE_SERVER_DEBUG_DIALOG_ID,
  onClose,
  copyText
}: RemoteServerDebugDialogProps) {
  // 显式标注快照类型：扩展包对 React 类型是 peer/dev 依赖，跨包推断会退化成 unknown。
  const snapshot: RemoteServerSnapshot = useSyncExternalStore<RemoteServerSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const [state, setState] = useState<LoadState>({ snapshot: null, error: null, loading: true });
  const [copyState, setCopyState] = useState<
    { kind: "idle" } | { kind: "ok"; count: number } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [reportState, setReportState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "ok"; acceptedCount: number } | { kind: "error"; message: string }
  >({ kind: "idle" });

  /** 在途标记：轮询是固定间隔的，宿主慢的一次读取不能叠出第二、第三次请求。 */
  const inflight = useRef(false);
  /** 上报在途标记：状态更新是异步的，连点两下不能发出两次上报。 */
  const reportInflight = useRef(false);
  const alive = useRef(true);

  const read = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const result = await service.api.loadDiagnostics();
      if (!alive.current) return;
      if (result.ok) {
        setState({ snapshot: result.snapshot, error: null, loading: false });
      } else {
        // 失败不清掉上一次成功的数据：诊断窗口展示的是一段时间窗，短暂读失败不该把证据抹掉。
        setState((previous) => ({ snapshot: previous.snapshot, error: result.error, loading: false }));
      }
    } finally {
      inflight.current = false;
      if (alive.current) setState((previous) => (previous.loading ? { ...previous, loading: false } : previous));
    }
  }, [service]);

  useEffect(() => {
    alive.current = true;
    void read();
    const timer = setInterval(() => {
      void read();
    }, REMOTE_SERVER_DEBUG_POLL_INTERVAL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [read]);

  const entries = state.snapshot?.entries ?? [];
  const unavailable = state.snapshot !== null && state.snapshot.available === false;
  const connected = snapshot.phase === "connected";

  const copy = useCallback(async () => {
    const lines = formatDiagnosticsText(entries);
    try {
      await (copyText ?? defaultCopyText)(lines);
      if (alive.current) setCopyState({ kind: "ok", count: entries.length });
    } catch (error) {
      if (alive.current) {
        setCopyState({ kind: "error", message: error instanceof Error ? error.message : "复制失败" });
      }
    }
  }, [copyText, entries]);

  const report = useCallback(async () => {
    if (reportInflight.current) return;
    reportInflight.current = true;
    setReportState({ kind: "busy" });
    const result = await service.api.reportDiagnostics();
    reportInflight.current = false;
    if (!alive.current) return;
    setReportState(
      result.ok
        ? { kind: "ok", acceptedCount: result.acceptedCount }
        : { kind: "error", message: result.error }
    );
  }, [service]);

  const statusText =
    state.loading && state.snapshot === null
      ? "正在读取…"
      : state.error !== null
        ? `读取失败：${state.error}`
        : unavailable
          ? "宿主不支持诊断缓冲"
          : state.snapshot
            ? `最近 ${entries.length} 条 · 采于 ${formatDiagnosticClock(state.snapshot.capturedAt)} · 本次最多 ${state.snapshot.capacity} 条`
            : "正在读取…";

  return (
    <Dialog.Content
      variant="standard"
      size="lg"
      labelledBy={`${instanceId}-title`}
      instanceId={instanceId}
      {...(onClose ? { onOverlayClick: onClose } : {})}
    >
      <DialogHeader {...(onClose ? { onClose } : {})}>
        <DialogTitle id={`${instanceId}-title`}>服务端接入日志</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="remote-server-debug__note">只显示已脱敏的接入与同步事件，不含令牌。</p>

        <dl className="remote-server-debug__summary" data-testid="remote-debug-summary">
          <dt>状态</dt>
          <dd data-phase={snapshot.phase}>{PHASE_LABEL[snapshot.phase]}</dd>
          <dt>地址</dt>
          <dd>{snapshot.serverUrl ?? "—"}</dd>
          <dt>主体</dt>
          <dd>{snapshot.displayName ?? snapshot.subject ?? "—"}</dd>
          <dt>到期</dt>
          <dd>{snapshot.expiresAt ? new Date(snapshot.expiresAt).toLocaleString() : "—"}</dd>
        </dl>

        {unavailable ? (
          <p className="remote-server-debug__unavailable" data-testid="remote-debug-unavailable">
            当前宿主不支持接入日志（没有诊断缓冲）。这里不是「最近没有事件」，而是这个宿主根本没有记录。
          </p>
        ) : null}

        <p
          className="remote-server-debug__status"
          data-testid="remote-debug-status"
          data-state={state.loading ? "loading" : state.error ? "error" : "ready"}
        >
          {statusText}
        </p>

        {entries.length === 0 && !state.loading && state.error === null && !unavailable ? (
          <p className="remote-server-debug__empty">最近还没有接入事件。</p>
        ) : null}

        {entries.length > 0 ? (
          <ul className="remote-server-debug__list" data-testid="remote-debug-list">
            {entries.map((entry) => {
              const attributes = sortedDiagnosticAttributes(entry);
              return (
                <li
                  key={`${entry.seq}-${entry.time}-${entry.event}`}
                  className="remote-server-debug__entry"
                  data-testid="remote-debug-entry"
                  data-level={entry.level}
                >
                  <span className="remote-server-debug__time">{formatDiagnosticClock(entry.time)}</span>
                  <span className="remote-server-debug__level">{entry.level.toUpperCase()}</span>
                  <span className="remote-server-debug__category">{entry.category}</span>
                  <span className="remote-server-debug__event">{entry.event}</span>
                  {entry.code ? <span className="remote-server-debug__code">{entry.code}</span> : null}
                  {entry.message ? <span className="remote-server-debug__message">{entry.message}</span> : null}
                  {attributes.length > 0 ? (
                    <span className="remote-server-debug__attributes" data-testid="remote-debug-attributes">
                      {attributes.map(([key, value]) => (
                        <span className="remote-server-debug__attribute" data-testid="remote-debug-attribute" key={key}>
                          <span className="remote-server-debug__attribute-key">{key}=</span>
                          <span className="remote-server-debug__attribute-value">{value}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {copyState.kind !== "idle" ? (
          <p
            className="remote-server-debug__feedback"
            data-tone={copyState.kind === "ok" ? "success" : "danger"}
            data-testid="remote-debug-copy-result"
          >
            {copyState.kind === "ok" ? `已复制 ${copyState.count} 条` : `复制失败：${copyState.message}`}
          </p>
        ) : null}

        {reportState.kind !== "idle" ? (
          <p
            className="remote-server-debug__feedback"
            data-tone={reportState.kind === "ok" ? "success" : reportState.kind === "error" ? "danger" : "neutral"}
            data-testid="remote-debug-report-result"
          >
            {reportState.kind === "busy"
              ? "正在上报…"
              : reportState.kind === "ok"
                ? `已上报 ${reportState.acceptedCount} 条`
                : `上报失败：${reportState.message}`}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button size="sm" tone="ghost" onClick={() => void read()} data-testid="remote-debug-refresh">
          刷新
        </Button>
        <Button
          size="sm"
          tone="ghost"
          disabled={entries.length === 0}
          onClick={() => void copy()}
          data-testid="remote-debug-copy"
        >
          复制
        </Button>
        <Button
          size="sm"
          tone="primary"
          disabled={!connected || reportState.kind === "busy"}
          onClick={() => void report()}
          data-testid="remote-debug-report"
        >
          {reportState.kind === "busy" ? "上报中…" : "上报到服务端"}
        </Button>
        {onClose ? (
          <Button size="sm" onClick={onClose}>
            关闭
          </Button>
        ) : null}
      </DialogFooter>
    </Dialog.Content>
  );
}

/** Dialog Service 渲染器：把窗口接到宿主 Dialog 栈上。 */
export function createRemoteServerDebugDialogRenderer(service: RemoteDebugDialogService) {
  return function RemoteServerDebugDialogRenderer({ instance, requestClose }: DialogRendererProps) {
    return <RemoteServerDebugDialog service={service} instanceId={instance.instanceId} onClose={requestClose} />;
  };
}

/**
 * 注册调试窗口（幂等）。
 *
 * 两个装配入口都会调它：运行中的主插件，以及「扩展未运行、只装配设置」的 settings-only 工厂。
 * 后者只在宿主提供 `dialogs` 时才有窗口可开，所以先查已注册 id，避免重复注册抛错。
 */
export function ensureRemoteServerDebugDialog(dialogs: DialogsService, service: RemoteDebugDialogService): () => void {
  if (dialogs.registeredDialogIds().includes(REMOTE_SERVER_DEBUG_DIALOG_ID)) return () => undefined;
  return dialogs.registerDialog(REMOTE_SERVER_DEBUG_DIALOG_ID, {
    definition: remoteServerDebugDialogDefinition,
    renderer: createRemoteServerDebugDialogRenderer(service)
  });
}
