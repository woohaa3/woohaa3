import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";
import type { RuntimeIssue } from "../canvas-runtime/runtime-issues.js";
import type { ModelRenderIssue } from "../canvas-runtime/model-resource-failures.js";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { CloseIcon } from "@woohaa3/ui/icons";

const EMPTY: readonly ModelRenderIssue[] = [];
const noIssues = () => EMPTY;
const noSubscribe = () => () => undefined;
const EMPTY_RUNTIME: readonly RuntimeIssue[] = [];
const noRuntimeIssues = () => EMPTY_RUNTIME;

export function CanvasRenderWarnings({ runtime, onRetry }: { runtime: BevyRuntime | null; onRetry: () => void }) {
  const issues = useSyncExternalStore(runtime?.subscribeRenderIssues ?? noSubscribe, runtime?.getRenderIssues ?? noIssues, noIssues);
  const runtimeIssues = useSyncExternalStore(runtime?.subscribeRuntimeIssues ?? noSubscribe, runtime?.getRuntimeIssues ?? noRuntimeIssues, noRuntimeIssues);
  const fatal = runtimeIssues.some(issue => !issue.recoverable);
  const signature = useMemo(() => JSON.stringify([
    runtimeIssues.map(issue => [issue.key, issue.message]),
    issues.map(issue => [issue.nodeId, issue.title, issue.message])
  ]), [runtimeIssues, issues]);
  const hasIssues = issues.length > 0 || runtimeIssues.length > 0;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!hasIssues) setDismissed(current => current === null ? current : null);
  }, [hasIssues]);
  if (!hasIssues || dismissed === signature) return null;
  return (
    <aside className="canvas-render-warnings" role="alert" aria-label="画布预览问题">
      <div className="canvas-render-warnings__header">
        <strong>{fatal ? "画布预览暂时不可用，编辑现场仍保留" : runtimeIssues.some(issue => issue.scope === "frame")
          ? "画布预览更新遇到问题，正在尝试恢复" : "部分素材或动作未能加载，画布仍可操作"}</strong>
        <IconButton
          className="canvas-render-warnings__close"
          label="关闭画布提示"
          size="sm"
          onClick={() => setDismissed(signature)}
        >
          <CloseIcon size={16} />
        </IconButton>
      </div>
      <ul>
        {runtimeIssues.map(issue => (
          <li key={issue.key}>
            <span>{issue.nodeId ? `${issue.nodeId}：` : ""}{issue.message}</span>
            {issue.retainedPreview && <span> 当前保留上次成功上传的预览。</span>}
            <details><summary>查看错误详情</summary><pre>{issue.detail}</pre></details>
          </li>
        ))}
        {issues.map((issue) => (
          <li key={issue.nodeId}>
            <span>{issue.title}：{issue.message}</span>
            <span>{issue.retainedPreview ? " 当前显示上次成功加载的预览。" : " 当前保留节点，暂不显示模型预览。"}</span>
            <details><summary>查看错误详情</summary><pre>{issue.detail}</pre></details>
          </li>
        ))}
      </ul>
      {fatal && runtime?.recoverRuntime && <Button size="sm" onClick={() => runtime.recoverRuntime?.()}>重建画布预览</Button>}
      {!fatal && (issues.length > 0 || runtimeIssues.some(issue => issue.recoverable)) &&
        <Button size="sm" onClick={onRetry}>{runtimeIssues.length ? "重试预览" : "重试模型预览"}</Button>}
    </aside>
  );
}
