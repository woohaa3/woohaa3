/**
 * 遥测复盘页的事件详情侧栏
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2 / design D9）。
 *
 * 只读：展示单条已落库事件的完整形状（属性、traceId、两个时间、前端版本）。
 * 两个时间必须分开显示——`receivedAt` 是宿主接收时间（窗口/排序/保留都认它），
 * `occurredAt` 是上报端时钟且可能是 0（不可信/未知），把二者混为一谈会让"什么时候发生的"
 * 变成一句猜测。
 */
import type { TelemetryEventRecord } from "@woohaa3/contracts";
import { Button, CloseIcon } from "@woohaa3/ui";
import { eventNameLabel, formatDuration, formatLocalTime, resultLabel } from "./format.js";

export function EventDetailPanel({
  event,
  onClose
}: {
  event: TelemetryEventRecord;
  onClose: () => void;
}) {
  const attributes = Object.entries(event.attributes ?? {});
  return (
    <aside className="telemetry__detail" data-testid="telemetry-detail">
      <header className="telemetry__detail-head">
        <div>
          <h2>事件详情</h2>
          <p className="telemetry__detail-sub">
            {eventNameLabel(event.name)} · {resultLabel(event.result)}
          </p>
        </div>
        <Button size="sm" tone="ghost" icon={<CloseIcon />} onClick={onClose} aria-label="关闭详情">
          关闭
        </Button>
      </header>

      <dl className="telemetry__detail-list">
        <div>
          <dt>接收时间</dt>
          <dd>{formatLocalTime(event.receivedAt)}</dd>
        </div>
        <div>
          <dt>上报时间</dt>
          <dd>{event.occurredAt > 0 ? formatLocalTime(event.occurredAt) : "未知（时钟不可信）"}</dd>
        </div>
        <div>
          <dt>事件名</dt>
          <dd>
            {event.name}
          </dd>
        </div>
        <div>
          <dt>结果</dt>
          <dd>{resultLabel(event.result)}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{formatDuration(event.durationMs)}</dd>
        </div>
        <div>
          <dt>错误码</dt>
          <dd>{event.errorCode ? <code>{event.errorCode}</code> : "—"}</dd>
        </div>
        <div>
          <dt>来源 / 界面</dt>
          <dd>
            {event.origin}
            {event.surface ? ` · ${event.surface}` : ""}
          </dd>
        </div>
        <div>
          <dt>前端版本</dt>
          <dd>{event.frontendVersion ?? "未知"}</dd>
        </div>
        <div>
          <dt>traceId</dt>
          <dd>{event.traceId ? <code>{event.traceId}</code> : "无"}</dd>
        </div>
        <div>
          <dt>记录 id</dt>
          <dd>{event.id}</dd>
        </div>
      </dl>

      <h3 className="telemetry__detail-title">属性</h3>
      {attributes.length === 0 ? (
        <p className="telemetry__empty" data-testid="telemetry-detail-attributes-empty">
          这条事件没有属性。
        </p>
      ) : (
        <table className="telemetry__table telemetry__table--compact">
          <caption className="visually-hidden">事件属性</caption>
          <tbody>
            {attributes.map(([key, value]) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </aside>
  );
}
