/**
 * 本机 Agent 目标回合的提示词
 * （change: 2026-10-17-add-agent-appserver-and-sdk-connections；任务 6.3 泛化）。
 *
 * App Server 只接收本轮的文本 prompt；画布目标不会自动进入模型上下文。若只转发用户原话，
 * 模型既不知道 canvasId/nodeId，也不知道该用哪些画布工具，只能反问用户上传图片或模型文件。
 * 这里把**冻结目标**和受控读写流程显式写进 prompt，不携带 grant/token 或其他秘密。
 *
 * 业务目标的工具与提示词来自激活扩展的 `ContentAgentTarget`；本文件只保留通用画布/模型规则。
 */
import type { AgentEntryIntent, ContentAgentTarget } from "@woohaa3/contracts";

function targetLine(intent: AgentEntryIntent): string {
  const mode = intent.mode ?? "model3d";
  return [
    `canvasId="${intent.canvasId}"`,
    `nodeId="${intent.nodeId ?? ""}"`,
    `mode="${mode}"`,
    ...(intent.clipId ? [`clipId="${intent.clipId}"`] : []),
    ...(intent.itemId ? [`itemId="${intent.itemId}"`] : []),
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

function declaredTarget(mode: string, targets: readonly ContentAgentTarget[]): ContentAgentTarget | undefined {
  return targets.find((target) => target.mode === mode);
}

/** 按目标模式构造一次目标回合的完整 prompt。 */
export function buildTargetPrompt(
  intent: AgentEntryIntent,
  requestId: string,
  targets: readonly ContentAgentTarget[] = []
): string {
  const mode = intent.mode ?? "model3d";
  const lines = [
    "你是 Woohaa3 Model Canvas 的 3D 创作 Agent。",
    `目标：${targetLine(intent)}。`,
    ...commonRules()
  ];

  if (mode === "text") {
    lines.push("文本目标由可信文本交付入口处理；本轮不要调用画布写入工具。");
  } else if (mode === "canvas-group") {
    lines.push(
      "目标是受控画布组，nodeId 是本轮授权的根组；不要将组目标当作 model3d 节点处理。",
      "先用 get_canvas_capabilities / get_canvas_graph 了解组内能力与现状，再读 get_canvas_script_api 获取脚本 API。",
      "用 validate_canvas_script 校验，再用 submit_canvas_script 提交；布局坐标按 API 的 absolute 约定，只操作授权根组及其内部节点。",
      "组形象是可选的自身子资源，不是成员或输出。仅当用户要求调整识别形象时，调用 get_model_node(resource=group-appearance) 读取默认/自定义定义和 contentHash，再用 submit_model_script(resource=group-appearance, expectedContentHash=读取值) 提交，并核对真实 commandId 回执；不得借此移动根组或修改其它根组字段。",
      "保留未提及的组内内容；修改其他组或组外节点不在本轮授权范围。",
      "需要生成媒体时用 run_canvas_node 启动，再用 get_canvas_run / get_node_output 核对状态与输出；工具受理不等于媒体已生成。",
      "创建普通模型用 canvas.node(\"model\")；业务内容由能力目录中的扩展工具创建，先读取 get_canvas_capabilities 的目标与工具声明，不要臆造业务 kind、字段或提交入口。",
      "3D、业务扩展内容与媒体先读取对应 API 和稳定 id；只有工具确认成功后才报告完成。"
    );
  } else if (mode === "camera") {
    lines.push("camera 目标模式已停用：它只保留在协议里用于解码旧会话，不再发放工具，也不应发起新的目标回合。");
  } else if (mode !== "model3d") {
    const target = declaredTarget(mode, targets);
    if (target) {
      lines.push(
        `本轮业务目标是 ${target.extensionId} 的「${target.mode}」目标；只使用该目标声明的读写工具，不扩大到其他 owner。`,
        ...target.prompt
      );
    } else {
      lines.push(
        "当前目标 mode 未被任何激活扩展公布，或对应扩展已停用；只做只读检查并如实说明不可用，不要调用写入工具或伪造业务内容。"
      );
    }
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
