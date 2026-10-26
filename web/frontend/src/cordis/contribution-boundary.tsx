/**
 * 扩展 slot 贡献的逐项渲染错误边界
 * （change: 2026-10-21-harden-extension-fault-isolation，design D2，任务 2.2）。
 *
 * 只包**来源为扩展**的贡献（来源身份由宿主盖章，见 `slots.ts`）；宿主内置贡献原样渲染，出错仍由
 * 外层 Panel/App 边界兜底，避免掩盖宿主自身缺陷。扩展贡献抛错时只替换该项：
 * - `compact`：工具栏/顶栏/条目动作位置的同尺寸 ⚠ 占位，悬停显示扩展与错误摘要；
 * - `hidden`：overlay 类直接隐藏；
 * - `card`：设置面板/配置区的错误卡片。
 *
 * 错误同时上报 App 级 `extensionFaults`（诊断 + 会话内熔断）。`resetKey` 取 extensionId+epoch：
 * 扩展被重新装配后自动重置。
 */
import { useContext, type ComponentType, type ReactNode } from "react";
import { RuntimeContextForBoundary } from "./react.js";
import { RenderErrorBoundary } from "./app-error-boundary.js";
import { slotContributionOrigin } from "./slots.js";
import type { ExtensionFaultService } from "./extension-faults.js";
import { guardContributionCall } from "./contribution-guard.js";
import type { SlotContribution } from "./contract/platform.js";
import "./contribution-boundary.css";

/** App 级扩展故障服务（无 runtime / 未提供时为 undefined）。 */
export function useExtensionFaults(): ExtensionFaultService | undefined {
  const runtime = useContext(RuntimeContextForBoundary);
  return runtime?.ctx.get("extensionFaults" as never) as ExtensionFaultService | undefined;
}

/** 右下角面板的一个功能图标动作（与 host.tsx `ControlPanelAction` 同形）。 */
type GuardedToolbarAction = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone?: "primary";
  /** 功能自带的上下文引导（可选；宿主内置语义原样透传）。 */
  tooltip?: ComponentType<{ children: ReactNode }>;
  onActivate: () => void;
  disabled?: boolean;
};

/**
 * `canvas.toolbar-action` 贡献 → 面板动作：扩展贡献的图标逐项包边界，`onActivate`/`available`
 * 抛错归因并计入熔断（不执行/视为可用）；宿主内置贡献语义不变。
 */
export function guardedToolbarAction(entry: SlotContribution<"canvas.toolbar-action">, faults: ExtensionFaultService | undefined): GuardedToolbarAction {
  return {
    id: entry.id,
    label: entry.label,
    icon: guardedActionIcon(entry),
    tone: entry.tone,
    ...(entry.tooltip ? { tooltip: entry.tooltip } : {}),
    onActivate: () => guardContributionCall(entry, "canvas.toolbar-action", faults, () => entry.onActivate(), undefined),
    disabled: entry.available ? !guardContributionCall(entry, "canvas.toolbar-action", faults, () => entry.available!(), false) : false
  };
}

/**
 * 扩展工具栏动作图标的逐项边界：按贡献对象缓存包装组件，避免每次渲染换组件类型导致重挂载。
 * 宿主内置贡献原样返回。
 */
const guardedIcons = new WeakMap<object, ComponentType<{ className?: string }>>();
function guardedActionIcon(entry: SlotContribution<"canvas.toolbar-action">): ComponentType<{ className?: string }> {
  if (slotContributionOrigin(entry).kind !== "extension") return entry.icon;
  const cached = guardedIcons.get(entry);
  if (cached) return cached;
  const Icon = entry.icon;
  const Guarded = (props: { className?: string }) => (
    <ContributionBoundary entry={entry} slot="canvas.toolbar-action"><Icon {...props} /></ContributionBoundary>
  );
  guardedIcons.set(entry, Guarded);
  return Guarded;
}

export type ContributionFallback = "compact" | "hidden" | "card";

export type ContributionBoundaryProps = {
  /** 被渲染的 slot 贡献或 Dialog renderer（宿主盖章所在的对象）。 */
  entry: object & { id?: string };
  slot: string;
  fallback?: ContributionFallback;
  /** 出错时改为渲染宿主提供的替代内容（例如宿主自有的同步状态读数）；优先于 `fallback`。 */
  replacement?: ReactNode;
  children: ReactNode;
};

export function ContributionBoundary({ entry, slot, fallback = "compact", replacement, children }: ContributionBoundaryProps): ReactNode {
  const origin = slotContributionOrigin(entry);
  const runtime = useContext(RuntimeContextForBoundary);
  if (origin.kind !== "extension") return children;
  const faults = runtime?.ctx.get("extensionFaults" as never) as ExtensionFaultService | undefined;
  return (
    <ExtensionContributionBoundary
      extensionId={origin.extensionId}
      epoch={origin.epoch}
      slot={slot}
      contributionId={entry.id ?? slot}
      fallback={fallback}
      replacement={replacement}
      {...(faults ? { faults } : {})}
    >
      {children}
    </ExtensionContributionBoundary>
  );
}

function ExtensionContributionBoundary({
  extensionId,
  epoch,
  slot,
  contributionId,
  fallback,
  replacement,
  faults,
  children
}: {
  extensionId: string;
  epoch: number;
  slot: string;
  contributionId: string;
  fallback: ContributionFallback;
  replacement?: ReactNode;
  faults?: ExtensionFaultService;
  children: ReactNode;
}) {
  return (
    <RenderErrorBoundary
      resetKey={`${extensionId}:${epoch}`}
      onError={(message) => faults?.report({ extensionId, epoch, slot, contributionId, message })}
      fallback={({ error }) => replacement !== undefined
        ? replacement
        : <ContributionErrorFallback kind={fallback} extensionId={extensionId} slot={slot} error={error} />}
    >
      {children}
    </RenderErrorBoundary>
  );
}

export function ContributionErrorFallback({ kind, extensionId, slot, error }: { kind: ContributionFallback; extensionId: string; slot: string; error: string }): ReactNode {
  if (kind === "hidden") return null;
  const summary = `扩展「${extensionId}」的界面渲染失败：${error}`;
  if (kind === "card") {
    return (
      <div className="render-error-fallback" role="alert" data-diagnostic="extension-render-error" data-extension-id={extensionId} data-slot={slot}>
        <p className="render-error-fallback__message">{summary}</p>
      </div>
    );
  }
  return (
    <span className="contribution-error" title={summary} data-diagnostic="extension-render-error" data-extension-id={extensionId} data-slot={slot}>
      ⚠
    </span>
  );
}
