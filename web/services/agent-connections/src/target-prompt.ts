/**
 * 本机 Agent 目标回合的提示词
 * （change: 2026-10-17-add-agent-appserver-and-sdk-connections）。
 *
 * App Server 只接收本轮的文本 prompt；画布目标不会自动进入模型上下文。若只转发用户原话，
 * 模型既不知道 canvasId/nodeId，也不知道该用哪些画布工具，只能反问用户上传图片或模型文件。
 * 这里把**冻结目标**和受控读写流程显式写进 prompt，不携带 grant/token 或其他秘密。
 */
import type { AgentEntryIntent } from "@woohaa3/contracts";

function targetLine(intent: AgentEntryIntent): string {
  const mode = intent.mode ?? "model3d";
  return [
    `canvasId="${intent.canvasId}"`,
    `nodeId="${intent.nodeId ?? ""}"`,
    `mode="${mode}"`,
    ...(intent.cameraId ? [`cameraId="${intent.cameraId}"`] : [])
  ].join(", ");
}

function commonRules(): string[] {
  return [
    "你正在通过 Woohaa3 Model Canvas 的受控 MCP 工具编辑画布，不要要求用户上传图片或模型文件。",
    "宿主已在本轮会话配置远程 MCP 连接和授权；直接调用提供的画布工具，无须安装 MCP 或改写本机配置。",
    "目标节点已经存在于画布中；必须先读取权威内容，再按用户请求做最小必要修改。",
    "只有工具返回成功后才能说“已修改”；工具失败或被拒绝时必须如实说明，不能假装完成。"
  ];
}

/** 按目标模式构造一次目标回合的完整 prompt。 */
export function buildTargetPrompt(intent: AgentEntryIntent, requestId: string): string {
  const lines = [
    "你是 Woohaa3 Model Canvas 的 3D 创作 Agent。",
    `目标：${targetLine(intent)}。`,
    ...commonRules()
  ];

  if (intent.mode === "camera") {
    lines.push(
      "camera 目标模式已停用：它只保留在协议里用于解码旧会话，不再发放工具，也不应发起新的目标回合。"
    );
  } else if (intent.mode !== undefined && intent.mode !== "model3d") {
    lines.push("该目标模式已随画布组与片场功能一起停用，不再发放工具；请改用 model3d 目标。");
  } else {
    lines.push(
      "流程：先调用 get_model_api 了解当前脚本 API，再调用 get_model_node 读取权威 nodeType、当前 modelScript、modelContentVersion 与 cameras。",
      "然后只做用户要求的增量修改，保留未提及的部件、材质、尺寸与层级；除非用户明确要求重建，不要整体重写模型。",
      "用 submit_model_script 提交完整脚本，并带上稳定 requestId 与读取到的 expectedModelContentHash。",
      "点数/面数只引用 get_model_statistics、get_model_node(includeStatistics=true) 或 submit_model_script 的返回；MUST NOT 按成本表自行推算（segment 缺省是 capsule，手算会严重低估）。"
    );
  }

  if (intent.expectedContentHash) lines.push(`宿主冻结的内容哈希：${intent.expectedContentHash}；提交前仍以工具读取结果为准。`);
  lines.push(`本次请求稳定 id：requestId="${requestId}"。`, `用户请求：${intent.prompt}`);
  return lines.join("\n");
}
