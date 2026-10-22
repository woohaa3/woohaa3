/**
 * MCP 连接与当前画布指引的纯派生文案。
 * AI 面板的 MCP tab 集中展示；节点级镜头工具复用目标指引。
 * 不发起 MCP 请求，不写画布，也不表示客户端已连接或获得授权。
 */
import { resolveModelMcpServerUrl } from "./mcp-endpoint.js";

/** 常驻指引的稳定前缀，单测与 e2e 共用。 */
export const MCP_HINT_PREFIX = "MCP 连接指引";

/** 第一行标签：安装服务（含服务器地址）。 */
export const MCP_HINT_INSTALL_LABEL = "安装 MCP";
/** 第一行引导语。 */
export const MCP_HINT_INSTALL_PREFIX = "安装这个 MCP 服务：";
/** 第二行标签：让 Agent 操作当前画布。 */
export const MCP_HINT_CANVAS_LABEL = "操作画布";

/** 第一行的可粘贴整句：面向「贴给 Agent 让它自己装」。 */
export const MCP_HINT_INSTALL_COPY_PREFIX = "安装这个 MCP 服务：";

/** 一行指引条目：标签 + 可直接复制/粘贴的整句。 */
export type McpHintLine = {
  /** 行标签，例如「安装 MCP」「操作画布」。 */
  label: string;
  /** 该行展示与复制的完整文案。 */
  value: string;
};

export type McpHintView = {
  /** 前缀短标签，例如「MCP 连接指引」。 */
  label: string;
  /** 同源 Streamable HTTP 服务器地址（与模型面板同源派生）。 */
  serverUrl: string;
  /** 当前画布 id；未知时为空串。 */
  canvasId: string;
  /** 两行内容（安装 + 操作画布）。 */
  lines: McpHintLine[];
  /** 供读屏与 tooltip 使用的完整界面文案（两行拼接）。 */
  text: string;
  /** 第一行「安装 MCP 服务」的可粘贴整句。 */
  installPayload: string;
  /** 第二行「让 Agent 操作当前画布」的可粘贴整句。 */
  canvasPayload: string;
};

/**
 * 让 Agent 操作指定画布的提示词整句
 * （change: 2026-09-29-split-mcp-hint-by-canvas）。
 *
 * 与模型面板的 `modelPromptGuide` 同一约定：显式带上画布 id，使多画布下 Agent 明确操作对象。
 */
export function mcpCanvasPrompt(canvasId: string): string {
  const target = canvasId ? `画布 ${canvasId}` : "当前画布";
  return `使用 Woohaa3 Model Canvas MCP 操作${target}：先调用 list_model_requests 了解节点，再用 get_model_node / submit_model_script 读写。`;
}

/**
 * 模型聚焦编辑器工具栏的「镜头 MCP 控制指引」
 * （change: add-model-camera-mcp-crud）。
 *
 * 纯派生文案：显式带上画布 id、节点 id、当前选中镜头 id 与该节点现有的全部镜头 id/名称，
 * 并列出镜头读工具、单条 CRUD 工具与整体替换工具，使外部 Agent 无需用户口述即可精确操作
 * 指定镜头。随选中镜头变化。不发起请求、不写画布。
 *
 * 与 3D 模型节点的提示词指引（`modelPromptGuide`）同一约定：指引文本**不内嵌服务器地址**，
 * 地址由面板单独的只读字段承载；此处同样不再拼接 `serverUrl`。
 */
export function cameraMcpGuide(
  canvasId: string,
  nodeId: string,
  cameras: ReadonlyArray<{ id: string; name: string }> = [],
  selectedCameraId: string | null = null
): string {
  const target = canvasId ? `画布 ${canvasId} 的节点 ${nodeId}` : `节点 ${nodeId}`;
  const lines = [`使用 Woohaa3 Model Canvas MCP 控制${target}的镜头：`];
  if (cameras.length > 0) {
    const list = cameras.map((camera) => `${camera.id}（${camera.name}）`).join("、");
    lines.push(`现有镜头：${list}。`);
  }
  if (selectedCameraId) {
    lines.push(`当前选中镜头：${selectedCameraId}（单条 update/delete/rename/reset 传该 cameraId）。`);
  }
  lines.push(
    "先调用 get_model_cameras 读取现有镜头与稳定 id（字段含 azimuth/elevation/distance/aspect/focusOffset）；",
    "再用 create_model_camera / update_model_camera / delete_model_camera / rename_model_camera / reset_model_camera 单条增删改（写工具带稳定 requestId 以便幂等重试）；",
    "需要一次性重建整组镜头时用 set_model_camera 整体替换。"
  );
  return lines.join("\n");
}

/** 由同源端点与画布 id 派生 MCP 指引。 */
export function mcpHintView(
  serverUrl: string = resolveModelMcpServerUrl(),
  canvasId = ""
): McpHintView {
  const installValue = `${MCP_HINT_INSTALL_COPY_PREFIX}${serverUrl}`;
  const canvasValue = mcpCanvasPrompt(canvasId);
  const lines: McpHintLine[] = [
    { label: MCP_HINT_INSTALL_LABEL, value: installValue },
    { label: MCP_HINT_CANVAS_LABEL, value: canvasValue }
  ];
  return {
    label: MCP_HINT_PREFIX,
    serverUrl,
    canvasId,
    lines,
    text: `${MCP_HINT_PREFIX}：${installValue}\n${canvasValue}`,
    installPayload: installValue,
    canvasPayload: canvasValue
  };
}
