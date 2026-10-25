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

/** 按目标模式构造一次目标回合的完整 prompt。 */
export function buildTargetPrompt(intent: AgentEntryIntent, requestId: string): string {
  const mode = intent.mode ?? "model3d";
  const lines = [
    "你是 Woohaa3 Model Canvas 的 3D 创作 Agent。",
    `目标：${targetLine(intent)}。`,
    ...commonRules()
  ];

  if (mode === "canvas-group") {
    lines.push("目标是受控画布组，nodeId 是本轮授权的根组；不要将组目标当作 model3d 节点处理。",
      "先用 get_canvas_capabilities / get_canvas_graph 了解组内能力与现状，再读 get_canvas_script_api 获取脚本 API。",
      "用 validate_canvas_script 校验，再用 submit_canvas_script 提交；布局坐标按 API 的 absolute 约定，只操作授权根组及其内部节点。",
      "组形象是可选的自身子资源，不是成员或输出。仅当用户要求调整识别形象时，调用 get_model_node(resource=group-appearance) 读取默认/自定义定义和 contentHash，再用 submit_model_script(resource=group-appearance, expectedContentHash=读取值) 提交，并核对真实 commandId 回执；不得借此移动根组或修改其它根组字段。",
      "保留未提及的组内内容；修改其他组或组外节点不在本轮授权范围。",
      "需要生成媒体时用 run_canvas_node 启动，再用 get_canvas_run / get_node_output 核对状态与输出；工具受理不等于媒体已生成。",
      "3D、片场、镜头等内容先读取对应 API 和 clip/item 的稳定 id；只有工具确认成功后才报告完成。");
  } else if (mode === "camera") {
    lines.push(
      "流程：先调用 get_model_node 和 get_model_cameras 读取当前镜头集合及稳定 id；",
      "再用 create_model_camera / update_model_camera / delete_model_camera / rename_model_camera / reset_model_camera 做单条修改，或仅在需要整体替换时使用 set_model_camera。",
      "保留未提及的镜头、顺序、名称与参数；只调整用户指定的构图或镜头。"
    );
  } else if (mode === "film-set") {
    lines.push(
      "流程：先调用 get_model_api 了解脚本 API，再调用 get_model_node 读取完整 animation 和 snapshotHash；需要片段时调用 get_film_set_clips。",
      "生成或增添场景对象用 submit_film_set，在现有节点保存完整 filmSetContent 与 filmSetAnimations，expectedSnapshotHash 使用读取到的 snapshotHash；片场只有地面或为空也能生成。主要对象分别建模，新 model item 的 model 提供 modelScript、modelScriptLanguage=javascript、modelScriptVersion=woohaa-model-js-v2，版本和哈希由宿主派生。",
      "片场不保存顶层模型脚本。修改已有模型用 import_model_snapshot 并指定 itemId；片场对象变换/绑定/片段用 mutate_film_set_item / mutate_film_set_clip。仅有 clipId/itemId 的动作目标必须使用局部工具，不得整体提交。",
      "只有明确要求在另一节点新建片场时才使用 create_film_set_node。",
      "图片/视频（含做成图片的文字）用 add_film_set_media 放入片场，画布拖放仍只接受模型；",
      "成片导出用 export_film_set_clip（standard / hd / hd60）并以 get_film_set_export 轮询；原生不可用时它会返回 recording-unavailable，请如实告知用户改用界面上的「生成视频」。",
      "保留未提及的对象、片段、运动、镜头与时间线；修改后核对运动适配状态。"
    );
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
