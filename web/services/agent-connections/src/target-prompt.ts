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
    ...(intent.worldScope
      ? [intent.worldScope.kind === "scene-area"
          ? `scope="scene-area:${intent.worldScope.areaId}"`
          : intent.worldScope.kind === "world-camera"
            ? `scope="world-camera:${intent.worldScope.cameraId}"`
            : `scope="workflow-group-2d:${intent.worldScope.groupId}"`]
      : []),
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

  if (intent.mode === "canvas-group") {
    lines.push(
      "目标是 2D 组（workflow-group-2d）：nodeId 是本轮授权的根组，宿主把读写限制在根组与 memberNodeIds 成员内。",
      "先调用 get_canvas_capabilities / get_canvas_graph 了解组内现状，再读 get_canvas_script_api 获取脚本 API。",
      "用 validate_canvas_script 校验，再用 submit_canvas_script 提交；布局坐标按 API 的 absolute 约定，只操作根组与成员。",
      "创建节点用 canvas.node(kind, …)：组作用域内新节点会自动进入根组成员表，不需要、也不能自行改 parentId 或成员表以外的根组字段。",
      "整理成员用 canvas.layout（宫格/单列/单行由 columns 表达），移动用 canvas.move；需要调整组卡片或成员卡片大小时用 canvas.resize(node, { width, height })。",
      "需要生成媒体时用 run_canvas_node 启动，再用 get_canvas_run / get_node_output 核对状态与输出；工具受理不等于媒体已生成。",
      "共享世界中的模型/镜头写入不属于本轮授权；需要改 3D 场景时如实说明应由导演区助手处理。",
      "保留未提及的组内内容；组外节点、任务与素材不得改动。"
    );
  } else if (intent.mode === "camera") {
    lines.push(
      "camera 目标模式已停用：它只保留在协议里用于解码旧会话，不再发放工具，也不应发起新的目标回合。"
    );
  } else if (intent.mode === "world" && intent.worldScope?.kind === "world-camera") {
    lines.push(
      "本轮是所选镜头的构图调整：只允许修改这一个镜头的 position、rotation、透视 FoV 和 aspect；不能创建或修改模型、导演区或其他镜头。",
      "先调用 get_world_context：camera.settings 是当前完整镜头配置；sceneModels 是拍摄内容的只读世界变换和模型局部包围盒（米），localBounds=null 表示边界未知。不得猜测不存在的物体。",
      "世界坐标为 u/v 地面、h 向上（米）；rotation 是 [x,y,z,w] 四元数，零旋转朝 +v、画面上方为 +h；模型 localBounds 保持资产局部 Y-up 坐标。FoV 使用 projection.kind=perspective、verticalFovRadians 为弧度。",
      "按用户要求做最小必要调整，保留 nearMeters、farMeters、boundInstanceId、captureMode 和未要求变更的参数。FoV 调整视野；推拉需要修改机位。",
      "使用 set_world_camera，cameraId 和 expectedSettingsVersion 必须来自刚读取的 camera.settings；每次成功写入后再次 get_world_context 核对真实参数，再决定是否继续调整。版本冲突或占用时如实报告，不得换镜头绕过。",
      "宿主会在本轮成功结束后按真实写入确认镜头版本并更新取景；只有工具返回成功才可以报告已调整。complete_world_camera 仅用于重试宿主已签发的完成确认。"
    );
  } else if (intent.mode === "world") {
    lines.push(
      "这是导演区/2D 组的共享世界创作目标。宿主已经签发本轮真实范围、版本、可写模型/镜头与只读参考；你不能自行声明或扩大范围。",
      "先调用 get_world_context 读取本轮上下文。只修改 writable 中的对象；read-only、部分包含、unknown 或区外对象只能参考，不能写入。",
      "导演区 get_world_context.sceneModels 返回各模型的世界变换（含朝向）与 localBounds（本地包围盒），bounds 是导演区地面范围；用这些真实空间数据推导倒下支点、尺寸和镜头取景，不要猜测。",
      "导演区 get_world_context.sceneArea.animationScript 是当前发布的完整动画脚本（null 表示尚无动画）。返修动画时先读取脚本并保留未要求修改的轨道；set_scene_animation_script 会替换整份脚本。旧宿主未返回 sceneArea 时不能猜测原动画或直接覆盖，应如实说明无法完成局部返修。写入后再次 get_world_context 核对发布结果。",
      "创建新模型用 create_world_model，替换内容用 replace_world_model_content，移动/改高度用 move_world_model，新建镜头用 create_world_camera，修改镜头用 set_world_camera。为导演区制作模型与镜头联合动画用 set_scene_animation_script：脚本通过注入的 motion 对象声明 motion.instance.tween(instanceId, { property: position|rotation|scale, startTime, endTime, from, to, easing }) 与 motion.camera.tween({ cameraId, property: position|rotation|zoom, startTime, endTime, from, to, easing })；目标必须是本轮可写的导演区内部部件，position 为世界 u/v/h，rotation 为角度制 [x,y,z]，h 轴朝上，zoom>1 更广。脚本编译一次后按时间确定性求值，播放不写规范文档。",
      "写 modelScript 前必须先调用 get_model_api 获取当前 woohaa-model-js-v2 的 scene.* API；脚本必须使用 scene.box/scene.cylinder 等 scene 接口，不要使用 THREE、export default 或浏览器模块写法。",
      "create_world_model 的 transform.position 使用世界 u/v 坐标，必须落在 get_world_context.bounds 内；新模型节点身份由宿主生成，不要传 nodeId。",
      "所有写入必须携带从 get_world_context 读取到的真实版本；工具拒绝时如实说明，不要改用别的对象或伪造版本。",
      "镜头修改是否留档由宿主在本轮成功结束后按真实写入与版本确认一次，模型自报或取景刷新都不是完成证据；complete_world_camera 只用于按宿主已签发的完成身份重试确认，宿主尚未确认时会返回未核实。",
      intent.worldScope?.kind === "workflow-group-2d"
        ? "本轮是 2D 组：只有只读参考，没有世界写工具。不得因为镜头卡片是该组成员而尝试修改世界。"
        : "本轮是导演区：只有完整包含且未被其他运行占用的对象可写。"
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
