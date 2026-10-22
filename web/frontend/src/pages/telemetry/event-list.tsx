/**
 * 遥测复盘页的事件列表与筛选工具栏
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2 / design D9）。
 *
 * 筛选分两层，与 URL 的边界一致：
 * - **URL 承载**：窗口（分段控件）、事件名、结果——都是有界枚举，改了立即生效并重置游标；
 * - **页面本地**：错误码是运行时取值（有 64 字符形状但取值空间不受控），不放进可分享的 URL，
 *   因此用草稿输入 + 显式「应用」，且草稿不触发请求（同 task-monitor 的草稿/已应用分离）。
 *
 * 列表本身是只读的：没有任何写入、取消或重跑入口——复盘页看的是已经发生的事实。
 */
import { useEffect, useState } from "react";
import {
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_RESULTS,
  TELEMETRY_WINDOWS,
  type TelemetryEventName,
  type TelemetryEventRecord,
  type TelemetryResult,
  type TelemetryWindow
} from "@woohaa3/contracts";
import { Button } from "../../shared/ui/Button.js";
import { SelectInput, TextInput } from "../../shared/ui/FormControls.js";
import { SegmentedControl } from "../../shared/ui/SegmentedControl.js";
import type { ListboxOption } from "../../shared/ui/Listbox.js";
import {
  WINDOW_SHORT_LABELS,
  eventNameLabel,
  formatDuration,
  formatLocalTime,
  localTimeZoneName,
  resultLabel
} from "./format.js";
import { normalizeErrorCodeFilter } from "./query.js";

const ALL = "__all__";

const NAME_OPTIONS: readonly ListboxOption[] = [
  { value: ALL, label: "全部事件" },
  ...TELEMETRY_EVENT_NAMES.map((name) => ({ value: name, label: `${eventNameLabel(name)}（${name}）` }))
];

const RESULT_OPTIONS: readonly ListboxOption[] = [
  { value: ALL, label: "全部结果" },
  ...TELEMETRY_RESULTS.map((result) => ({ value: result, label: resultLabel(result) }))
];

/** 筛选工具栏。 */
export function EventFilters({
  window,
  name,
  result,
  errorCode,
  onWindowChange,
  onNameChange,
  onResultChange,
  onErrorCodeApply,
  onClear
}: {
  window: TelemetryWindow;
  name?: TelemetryEventName;
  result?: TelemetryResult;
  errorCode?: string;
  onWindowChange: (window: TelemetryWindow) => void;
  onNameChange: (name: TelemetryEventName | undefined) => void;
  onResultChange: (result: TelemetryResult | undefined) => void;
  onErrorCodeApply: (errorCode: string | undefined) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(errorCode ?? "");
  // 错误码来自页面状态（清除筛选/从别处重置时），草稿跟随但只在空串时覆盖，避免吞掉用户输入。
  useEffect(() => {
    if (!errorCode) setDraft("");
  }, [errorCode]);
  const invalid = draft.trim() !== "" && normalizeErrorCodeFilter(draft) === undefined;

  return (
    <div className="telemetry__filters" data-testid="telemetry-filters">
      <div className="telemetry__filter-row">
        <SegmentedControl
          label="时间窗口"
          value={window}
          onValueChange={(next) => onWindowChange(next as TelemetryWindow)}
          options={TELEMETRY_WINDOWS.map((entry) => ({ value: entry, label: WINDOW_SHORT_LABELS[entry] }))}
          dataAttributes={{ "data-testid": "telemetry-window" }}
        />
        <div className="telemetry__filter-spacer" />
        <Button size="sm" tone="ghost" onClick={onClear} disabled={!name && !result && !errorCode}>
          清除筛选
        </Button>
      </div>
      <div className="telemetry__filter-row">
        <div className="telemetry__field">
          <span>事件名</span>
          <SelectInput
            label="按事件名筛选"
            value={name ?? ALL}
            options={NAME_OPTIONS}
            onValueChange={(next) => onNameChange(next === ALL ? undefined : (next as TelemetryEventName))}
          />
        </div>
        <div className="telemetry__field">
          <span>结果</span>
          <SelectInput
            label="按结果筛选"
            value={result ?? ALL}
            options={RESULT_OPTIONS}
            onValueChange={(next) => onResultChange(next === ALL ? undefined : (next as TelemetryResult))}
          />
        </div>
        <div className="telemetry__field">
          <span>错误码</span>
          <TextInput
            type="text"
            value={draft}
            placeholder="例如 local-save-failed"
            aria-label="按错误码筛选"
            aria-invalid={invalid}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                onErrorCodeApply(normalizeErrorCodeFilter(draft));
              }
            }}
          />
        </div>
        <Button
          size="sm"
          tone="primary"
          onClick={() => onErrorCodeApply(normalizeErrorCodeFilter(draft))}
          data-testid="telemetry-apply-error-code"
        >
          应用
        </Button>
      </div>
      {invalid ? (
        <p className="telemetry__field-hint" role="status" data-testid="telemetry-error-code-invalid">
          错误码只能是小写字母/数字/`.`/`_`/`:`/`-`，最长 64 字符；当前输入未生效。
        </p>
      ) : null}
    </div>
  );
}

/** 事件列表（最新在前；行可选中查看详情）。 */
export function EventTable({
  events,
  selectedEventId,
  onSelect
}: {
  events: readonly TelemetryEventRecord[];
  selectedEventId?: string;
  onSelect: (eventId: string) => void;
}) {
  return (
    <div className="telemetry__table-wrap" data-testid="telemetry-events">
      <table className="telemetry__table">
        <caption className="visually-hidden">本机遥测事件（最新在前，时间按{localTimeZoneName()}）</caption>
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">事件</th>
            <th scope="col">结果</th>
            <th scope="col">耗时</th>
            <th scope="col">错误码</th>
            <th scope="col">
              <span className="visually-hidden">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const selected = selectedEventId === String(event.id);
            return (
              <tr
                key={event.id}
                className={selected ? "is-selected" : undefined}
                aria-selected={selected}
                data-testid="telemetry-event-row"
              >
                <td className="telemetry__cell-time">{formatLocalTime(event.receivedAt)}</td>
                <th scope="row">
                  {eventNameLabel(event.name)}
                  <span className="telemetry__secondary">{event.name}</span>
                </th>
                <td>
                  <span className={`telemetry__result is-${event.result}`}>{resultLabel(event.result)}</span>
                </td>
                <td>{formatDuration(event.durationMs)}</td>
                <td className="telemetry__cell-code">{event.errorCode ? <code>{event.errorCode}</code> : "—"}</td>
                <td className="telemetry__cell-actions">
                  <Button size="sm" tone="ghost" onClick={() => onSelect(String(event.id))}>
                    查看详情
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 列表底部：游标「加载更多」与结束提示。 */
export function LoadMoreBar({
  nextCursor,
  loading,
  error,
  onLoadMore
}: {
  nextCursor?: string;
  loading: boolean;
  error?: string | null;
  onLoadMore: () => void;
}) {
  return (
    <div className="telemetry__load-more">
      {error ? (
        <p className="telemetry__field-hint" role="alert" data-testid="telemetry-events-error">
          {error}
        </p>
      ) : null}
      {nextCursor ? (
        <Button size="sm" tone="ghost" loading={loading} onClick={onLoadMore} data-testid="telemetry-load-more">
          加载更多
        </Button>
      ) : (
        <span className="telemetry__field-hint" data-testid="telemetry-events-end">
          已经到底了
        </span>
      )}
    </div>
  );
}
