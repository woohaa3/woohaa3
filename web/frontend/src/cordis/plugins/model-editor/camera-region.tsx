/** 生成入口直接呈现；外部工具镜头指引按需展开，缺少生成入口时保留完整指引。 */
import { useState, type ReactNode } from "react";
import { Collapsible } from "@woohaa3/ui/primitives";
import { ChevronDownIcon } from "@woohaa3/ui/icons";
import { cameraMcpGuide } from "../../mcp-hint.js";
import { Button } from "@woohaa3/ui/primitives";

export type CameraRegionProps = {
  nodeId: string;
  canvasId?: string;
  cameras?: ReadonlyArray<{ id: string; name: string }>;
  selectedCameraId?: string | null;
  copyText?: (value: string) => Promise<boolean | void>;
  /**
   * 通用 authoring 生成入口渲染闭包（由宿主从 `authoring.generate` slot 解析并绑定目标身份）。
   * 缺失时只显示 MCP 指引。
   */
  renderGenerate?: (() => ReactNode) | undefined;
};

export function CameraRegion(props: CameraRegionProps) {
  const guide = (
    <div className="mc-panel mc-panel--model" data-surface="dock" role="region" aria-label="镜头 MCP 控制">
      <CameraMcpGuide
        nodeId={props.nodeId}
        canvasId={props.canvasId}
        cameras={props.cameras}
        selectedCameraId={props.selectedCameraId}
        copyText={props.copyText}
      />
    </div>
  );
  if (!props.renderGenerate) return guide;

  return (
    <div className="model-editor__generation-region">
      {props.renderGenerate()}
      <Collapsible className="model-editor__external-guide" trigger={<><ChevronDownIcon size={14} />使用外部工具操作镜头</>}>
        {guide}
      </Collapsible>
    </div>
  );
}

/**
 * 镜头 MCP 控制指引（change: add-model-camera-mcp-crud）。
 *
 * 纯展示 + 复制入口：列出镜头读/写工具与调用顺序，带上画布 id 与节点 id，使外部 Agent
 * 可直接操作当前节点镜头。不发起 MCP 请求、不提交命令、不写 Y.Doc；历史只读时仍可见。
 */
export function CameraMcpGuide(props: {
  nodeId: string;
  canvasId?: string;
  cameras?: ReadonlyArray<{ id: string; name: string }>;
  selectedCameraId?: string | null;
  copyText?: (value: string) => Promise<boolean | void>;
}) {
  const [copied, setCopied] = useState(false);
  const guide = cameraMcpGuide(props.canvasId ?? "", props.nodeId, props.cameras ?? [], props.selectedCameraId ?? null);

  const copy = async () => {
    try {
      const ok = props.copyText
        ? await props.copyText(guide)
        : await navigator.clipboard.writeText(guide).then(() => true);
      setCopied(ok !== false);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="model-editor__mcp-guide" data-model-editor-mcp-guide="true">
      <div className="model-editor__mcp-guide-heading">
        <span className="model-editor__mcp-guide-title">镜头 MCP 控制</span>
        <Button className="model-editor__mcp-guide-copy" tone="neutral" size="sm" onClick={() => void copy()}>
          {copied ? "已复制" : "复制指引"}
        </Button>
      </div>
      <pre className="model-editor__mcp-guide-text">{guide}</pre>
    </div>
  );
}
