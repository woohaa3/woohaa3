/**
 * 执行面板 story 的公共舞台
 * （change: expand-showcase-execution-ux；壳层刷新见 2026-09-29-refresh-showcase-shell）。
 *
 * 每个 story 都渲染生产 `ModelExecutionHost`，并附上：
 * - `FixtureStage`：标题 / 说明 / 可视化操作记录；
 * - `ProductionFixtureHeader`：语义化 story 标题 + 说明 + 生产组件身份；
 * - `OperationLogPanel`：默认收起的 Collapsible diagnostics（任务 1.3、3.1、4.2 的断言面）。
 */
import { useSyncExternalStore, type ReactNode } from "react";
import {
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
  ActivityIcon,
  ChevronRightIcon
} from "../../../frontend/src/cordis/ui/index";
import {
  operationEntries,
  subscribeOperations,
  type OperationEntry
} from "./operations.js";

export function FixtureStage({
  children,
  note
}: {
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="showcase__stage">
      {children}
      {note ? <p className="showcase__hint">{note}</p> : null}
    </div>
  );
}

/**
 * Story header（change: 2026-09-29-refresh-showcase-shell，design D3）。
 *
 * 语义化 header：story `h1` + 说明 + 生产组件身份。原有 title / note 文案保持可被文本查询，
 * 不重命名 story，也不在每个 story 复制功能说明。
 */
export function ProductionFixtureHeader({ title, note }: { title: string; note?: string }) {
  return (
    <header className="showcase__story-header">
      <h1 className="showcase__story-title">{title}</h1>
      {note ? <p className="showcase__story-note">{note}</p> : null}
      <p className="showcase__story-meta">
        生产组件：<code>ModelExecutionHost</code>
      </p>
    </header>
  );
}

/**
 * Fixture 操作记录（change: 2026-09-29-refresh-showcase-shell，design D4）。
 *
 * Radix Collapsible 承载「次要 diagnostics」：trigger 显示事件计数与展开状态，初始无事件时收起。
 * 展开后仍渲染原 `<pre data-testid="fixture-operations" data-count>`，JSON 内容与 limit 语义不变；
 * 新事件只更新计数，不强制展开、不抢焦点。
 */
export function OperationLogPanel({ limit = 20 }: { limit?: number }) {
  const entries = useSyncExternalStore(subscribeOperations, operationEntries, operationEntries);
  return (
    <CollapsibleRoot className="showcase__ops" data-testid="fixture-operations-panel">
      <CollapsibleTrigger asChild>
        <button type="button" className="showcase__ops-trigger">
          <ChevronRightIcon className="showcase__ops-chevron" />
          <ActivityIcon className="showcase__ops-icon" />
          <span>fixture 操作记录</span>
          <span className="showcase__ops-count" data-testid="fixture-operations-count">
            {entries.length} 条
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="showcase__ops-content">
        <pre data-testid="fixture-operations" data-count={entries.length} className="showcase__ops-pre">
          {JSON.stringify(entries.slice(-limit), null, 2)}
        </pre>
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}

/** story 内联断言用的稳定文案（与 canvas fixture 的节点 id 对应）。 */
export function canvasCaption(kind: string): string {
  return `fixture 画布：${kind}`;
}

export type { OperationEntry };
