/**
 * Model Canvas MCP HTTP：指南文本与 grant 包装
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import type { ToolCallback, ToolAnnotations, RegisteredTool, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { HUMANOID_V1_JOINT_IDS, MODEL_CAMERA_ASPECTS, modelApiGuide, modelPrimitiveConstraintsText, modelRenderBudgetText, modelScaleGuidanceTextZh, motionApiGuideText } from "@woohaa3/contracts";
import { toolError } from "./tool-results.js";
import type { ToolRegistration } from "./http-types.js";

/** 参照输入与只读说明（所有版本共用）。 */
const REFERENCE_GUIDE = `生成或修改脚本前，先调用 get_model_node 读取该节点的“前序参考输入”（references）：
- kind: "text" 的条目带 text 字段（上游文字节点的权威内容）；
- kind: "image" / "video" / "audio" 的条目带 asset.storageKey 与同源 asset.url，可直接下载查看；
- 只有 status: ready 的媒体才有 asset，未就绪条目会带 pendingReason。`;

/**
 * 镜头 CRUD 指南（change: add-model-camera-mcp-crud）。
 */
const CAMERA_GUIDE = `镜头（nodeData.modelCameras）是模型节点的 canonical 子资源，不是独立画布节点：
- 先 get_model_cameras 读取现有镜头的稳定 id 与字段，再决定增删改；
- 单条操作用 create/update/delete/rename/reset_model_camera，服务端基于权威集合读改写，
  不要回传完整数组（那会覆盖同节点上的并发修改）；写工具需提供稳定 requestId 以幂等重试；
- 只有需要一次性重建整组镜头时才用 set_model_camera 整体替换（含 aspect 与 focusOffset）；
- 每条镜头字段：id/name/order/azimuth（弧度）/elevation（仰角弧度，必填）/distance（正）/aspect（${MODEL_CAMERA_ASPECTS.join("|")}，必填）/可选 focusOffset；
- 不要写选中镜头、hover、活动 handle、preview URL 或 capture busy 等瞬态状态，也不要创建
  camera/shot 节点或边。`;

/** 由 contracts descriptor 生成的版本/方法/示例指南，避免文档漂移（design D8）。 */
export function buildModelApiGuideText(): string {
  const guide = modelApiGuide();
  const methods = guide.methods.map((method) => `- ${method.signature}`).join("\n");
  return `Woohaa3 3D 模型脚本使用确定性的 JavaScript。
脚本版本：${guide.preferredVersion}

${REFERENCE_GUIDE}

${CAMERA_GUIDE}

SceneBuilder 方法：
${methods}

坐标与朝向约定（对齐 glTF 2.0 行业惯例，务必遵守）：
- ${guide.conventions.up} 朝上、${guide.conventions.front} 为模型正面、${guide.conventions.left} 为模型左侧；
- rotation 使用${guide.conventions.rotationUnit === "degrees" ? "角度制" : "弧度制"}，按固定 ${guide.conventions.rotationOrder} 顺序组合；
- position/rotation/scale 相对 parent 的局部空间；父 group 的变换与动画会作用到全部后代；
- 画布使用 dimetric 等距视图：local +Z（正面）投影到屏幕“左下方、面向观察者”，
  local +X（左侧）投影到“右下方”；请把正面放在 +Z 一侧，背面放在 -Z。

尺度约定（模型卡片与渲染共用同一现实基准）：
- ${modelScaleGuidanceTextZh()}

人形骨架（机甲、人物；白模视频要靠这些关节动起来）：
- 系统已经有这 ${HUMANOID_V1_JOINT_IDS.length} 个关节：${HUMANOID_V1_JOINT_IDS.join("、")}。
- 每个可见形状用 rig.joint("LeftUpperLeg") 这类调用做 parent。不要把肢体挂到 Root，也不要自造 thigh、shin、Shoulder、Chest、Neck、Hand。
- 手和枪用 rig.joint("LeftHand") / rig.joint("RightHand")，它们是前臂挂点，不是关节。
- 动作的 targetId 必须是上面的关节 id。原地跑步要给左右 UpperLeg、LowerLeg、Foot 各写不同的旋转轨道。工具返回成功不等于用了关节。
- 这条基准只描述模型自身的绝对尺寸；卡片按模型 extent 归一化显示，卡片里看起来一样大不代表
  实际尺寸一致。不要用卡片取景、节点矩形或画布 zoom 反推单位。

选择建议：
- 关节/球状部件用 scene.sphere；圆润肢体用 scene.capsule；方块肢体用 box segment；
- 斜向或连接两点的部件优先用 scene.segment（用共享关节点表达连续性，避免手写欧拉角）；
- 需要皮肤/布料的粗糙度、金属度或发光时先 scene.material 声明再按 id 复用；简单纯色用 color；
- mesh 只用于 primitive 无法表达的轮廓，不要用它重复生成球面或圆柱。

材质与约束：
- material 只支持受控 PBR 子集（baseColor/roughness/metallic/emissive/emissiveStrength/alphaMode/doubleSided/unlit/opacity）；
  不接受纹理 URL、本机路径、任意 shader 或未知字段；
- unlit:true 呈现不受光照影响的平面色，适合线框画布、示意卡片与文字图；
- opacity 是 0–1 的数字，只在 alphaMode:"blend" 下合法（缺省 0.6）；opaque 材质带 opacity 会被拒绝；
- 同一 shape 不得同时提供 material 与 color；颜色与镜头背景一律只写 6 位 #rrggbb。

渲染预算：
- ${modelRenderBudgetText()}

模型规模（点数/面数）：
- 点数与面数由权威 Scene IR 估算，与模型聚焦信息面板同源；需要引用这些数字时调用
  get_model_statistics（可用 source 预检候选脚本），或读取 get_model_node(includeStatistics=true)
  与 submit_model_script 的返回，MUST NOT 按上面的成本表自行推算——segment 缺省为 capsule，
  手算极易低估数十倍。

图元合法性约束：
- ${modelPrimitiveConstraintsText()}

对象 id 必须稳定且唯一，parent 必须先创建。脚本不得依赖随机数、当前时间、网络或文件系统；
同一脚本重复执行必须生成完全相同的场景。

连续人物示例（共享肘关节，上臂与前臂连接在同一点）：
${guide.example}

${motionApiGuideText()}`;
}

/**
 * 注册工具时对写工具套一层 grant 校验（单一拦截点，避免逐个 handler 遗漏）。
 */
export function createToolRegistrar(reg: ToolRegistration) {
  return function registerToolWithGrant<InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: StandardSchemaWithJSON;
      annotations?: ToolAnnotations;
      icons?: import("@modelcontextprotocol/server").Icon[];
      scopeChallenge?: import("@modelcontextprotocol/server").ScopeChallengeHandler;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>
  ): RegisteredTool {
    if (!reg.grantedTools.has(name)) return reg.server.registerTool(name, config, cb);
    const wrapped = ((args: Record<string, unknown>, extra: unknown) => {
      const denied = reg.grantDenied(name, { canvasId: args?.canvasId, nodeId: args?.nodeId, nodeIds: Array.isArray(args?.items) ? args.items.map((item: { nodeId: string }) => item.nodeId) : args?.nodeIds, cameraId: args?.cameraId });
      if (denied) return toolError(denied, "unauthorized");
      return (cb as (a: Record<string, unknown>, e: unknown) => unknown)(args, extra);
    }) as ToolCallback<InputArgs>;
    return reg.server.registerTool(name, config, wrapped);
  };
}
