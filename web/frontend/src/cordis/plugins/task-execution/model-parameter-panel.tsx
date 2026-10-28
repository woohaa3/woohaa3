/** 模型参数宿主：直接呈现生成入口；外部 MCP 指引由生成面板内的复制按钮承载。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExecutionPanelShell } from "../../ui/index.js";
import { Button, Tooltip } from "@woohaa3/ui";
import { resolveModelMcpServerUrl } from "../../mcp-endpoint.js";
import { MCP_HINT_INSTALL_COPY_PREFIX } from "../../mcp-hint.js";
import { isModelAuthoringNodeType } from "@woohaa3/contracts";

export type ModelParameterPanelProps = {
  canvasId?: string;
  nodeId: string;
  nodeType: string;
  /** 是否片场业务（composite-asset + extensionId="film-set"）；缺省按非片场处理。 */
  isFilmSet?: boolean;
  mcpServerUrl?: string;
  disabledReason?: string | null;
  /**
   * 通用 authoring 生成入口渲染闭包（由宿主从 `authoring.generate` slot 解析并绑定目标身份）。
   *
   * 缺失时只显示 MCP 指引（不出现不能工作的生成按钮）。宿主不解释其内部实现。
   */
  renderGenerate?: (() => ReactNode) | undefined;
  /**
   * 复制文本的注入点（缺省用系统 clipboard）。
   *
   * 返回 `false`（或抛错）表示复制失败。查看页用它注入确定性 adapter，
   * 以覆盖成功/失败反馈而不触碰运行主机的真实 clipboard。
   */
  copyText?: (value: string) => Promise<boolean | void>;
};

export function ModelParameterPanel(props: ModelParameterPanelProps) {
  // 自包含 3D 节点通过 MCP 编辑自身模型；旧模型节点仅作兼容。edit/shot 无 MCP 面板。
  const supportsModelScript = isModelScriptMcpNodeType(props.nodeType);
  const [copyFeedback, setCopyFeedback] = useState<{ field: "server" | "guide"; ok: boolean } | null>(null);

  const copy = useCallback(async (field: "server" | "guide", value: string) => {
    try {
      const copied = props.copyText
        ? await props.copyText(value)
        : await navigator.clipboard.writeText(value).then(() => true);
      setCopyFeedback({ field, ok: copied !== false });
    } catch {
      setCopyFeedback({ field, ok: false });
    }
  }, [props.copyText]);

  if (!supportsModelScript) return null;
  if (props.renderGenerate) return <>{props.renderGenerate()}</>;

  const mcpServerUrl = props.mcpServerUrl ?? "/mcp/model-canvas";
  const promptGuide = modelPromptGuide(props.canvasId, props.nodeId, props.isFilmSet === true);

  const mcpBody = (
    <div className="node-param-panel" data-node-id={props.nodeId}>
      <section className="node-param-panel__mcp" aria-labelledby={`model-mcp-${props.nodeId}`}>
        <div className="node-param-panel__mcp-heading">
          <strong id={`model-mcp-${props.nodeId}`}>MCP 模型生成</strong>
          <span>Streamable HTTP</span>
        </div>
        <label className="node-param-panel__mcp-field">
          <span>服务器地址</span>
          <span className="node-param-panel__mcp-control">
            <textarea readOnly rows={2} value={mcpServerUrl} aria-label="MCP 服务器地址" />
            <Button size="sm" onClick={() => void copy("server", mcpServerUrl)}>
              {copyFeedback?.field === "server" && copyFeedback.ok ? "已复制" : "复制"}
            </Button>
          </span>
          <span
            className="node-param-panel__copy-status"
            data-copy-field="server"
            data-status={copyFeedback?.field === "server" ? (copyFeedback.ok ? "copied" : "error") : "idle"}
            role="status"
            aria-live="polite"
          >
            {copyFeedback?.field === "server"
              ? copyFeedback.ok
                ? "复制成功"
                : "复制失败，请手动选择文本"
              : ""}
          </span>
        </label>
        <label className="node-param-panel__mcp-field">
          <span>提示词指引</span>
          <span className="node-param-panel__mcp-control">
            <textarea disabled rows={3} value={promptGuide} aria-label="MCP 模型提示词指引" />
            <Button size="sm" onClick={() => void copy("guide", promptGuide)}>
              {copyFeedback?.field === "guide" && copyFeedback.ok ? "已复制" : "复制"}
            </Button>
          </span>
          <span
            className="node-param-panel__copy-status"
            data-copy-field="guide"
            data-status={copyFeedback?.field === "guide" ? (copyFeedback.ok ? "copied" : "error") : "idle"}
            role="status"
            aria-live="polite"
          >
            {copyFeedback?.field === "guide"
              ? copyFeedback.ok
                ? "复制成功"
                : "复制失败，请手动选择文本"
              : ""}
          </span>
        </label>
      </section>
      {props.disabledReason ? <p className="node-param-panel__reason" role="note">{props.disabledReason}</p> : null}
    </div>
  );

  // 没有生成 contribution 的独立查看入口仍保留可选取的手动指引。
  return <ExecutionPanelShell ariaLabel="3D 模型编辑" className="mc-panel--model">{mcpBody}</ExecutionPanelShell>;
}

/** 生成面板内的外部 MCP 指引：悬停查看完整内容，点击复制同一份内容。 */
export function AuthoringMcpButton(props: Pick<ModelParameterPanelProps, "canvasId" | "nodeId" | "isFilmSet" | "mcpServerUrl" | "copyText">) {
  const content = `${MCP_HINT_INSTALL_COPY_PREFIX}${props.mcpServerUrl ?? resolveModelMcpServerUrl()}\n${modelPromptGuide(props.canvasId, props.nodeId, props.isFilmSet)}`;
  return <McpCopyButton key={content} content={content} copyText={props.copyText} />;
}

function McpCopyButton({ content, copyText }: { content: string; copyText?: ModelParameterPanelProps["copyText"] }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const copy = async () => {
    setState("copying");
    try {
      const result = copyText ? await copyText(content) : await navigator.clipboard.writeText(content);
      if (active.current) setState(result === false ? "failed" : "copied");
    } catch { if (active.current) setState("failed"); }
  };
  return <Tooltip className="authoring-generate__mcp-tooltip" side="top" align="start"
    content={<><strong>MCP 连接指引</strong><p>{content}</p><p>{state === "failed" ? "复制失败，请重试或手动选择指引。" : "点击 MCP 复制指引，交给外部助手。"}</p></>}>
    <button type="button" className="mc-panel__model-trigger" aria-label="复制 MCP 指引" disabled={state === "copying"} onClick={() => void copy()}>
      {state === "copied" ? "MCP · 已复制" : state === "failed" ? "MCP · 复制失败，重试" : "MCP"}
    </button>
  </Tooltip>;
}

export function modelPromptGuide(canvasId: string | undefined, nodeId: string, filmSet = false): string {
  const target = canvasId ? `画布 ${canvasId} 的节点 ${nodeId}` : `节点 ${nodeId}`;
  if (filmSet) {
    return `使用 Woohaa3 Model Canvas MCP 修改${target}片场；先调用 get_model_api 和 get_model_node 读取脚本 API、完整 animation 与 snapshotHash。生成或增添对象用 submit_film_set（带稳定 requestId 与 expectedSnapshotHash），在现有片场保存完整对象集合和片段；空片场或只有地面也可生成。保留未修改的对象、片段、运动和镜头。修改指定已有模型用 import_model_snapshot（必须指定 itemId），片段动作用 mutate_film_set_clip。片场不保存顶层模型脚本；创建另一片场才用 create_film_set_node。修改后检查运动适配状态。`;
  }
  return `使用 Woohaa3 Model Canvas MCP 生成或修改${target}；先调用 get_model_node，再调用 submit_model_script（带稳定 requestId 与 expectedModelContentHash）。点数/面数引用 get_model_statistics 或提交回执，不要自己按成本表推算（segment 缺省是 capsule）。`;
}

/** 具备 MCP 模型生成面板的节点类型（两类自包含 3D 节点）。 */
function isModelScriptMcpNodeType(nodeType: string): boolean {
  return isModelAuthoringNodeType(nodeType) || nodeType === "group";
}
