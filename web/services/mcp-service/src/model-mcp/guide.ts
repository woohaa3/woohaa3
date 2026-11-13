/**
 * Model Canvas MCP HTTP：指南文本与 grant 包装
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import type { ToolCallback, ToolAnnotations, RegisteredTool, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { HUMANOID_V1_JOINT_IDS, modelApiGuide, modelPrimitiveConstraintsText, modelRenderBudgetText, modelScaleGuidanceTextZh, motionApiGuideText } from "@woohaa3/contracts";
import { toolError } from "./tool-results.js";
import type { ToolRegistration } from "./http-types.js";

/** 参照输入与只读说明（所有版本共用）。 */
const REFERENCE_GUIDE = `生成或修改脚本前，先调用 get_model_node 读取该节点的“前序参考输入”（references）：
- kind: "text" 的条目带 text 字段（上游文字节点的权威内容）；
- kind: "image" / "video" / "audio" 的条目带 asset.storageKey 与同源 asset.url，可直接下载查看；
- 只有 status: ready 的媒体才有 asset，未就绪条目会带 pendingReason。`;

/** 由 contracts descriptor 生成的版本/方法/示例指南，避免文档漂移（design D8）。 */
export function buildModelApiGuideText(): string {
  const guide = modelApiGuide();
  const methods = guide.methods.map((method) => `- ${method.signature}`).join("\n");
  return `Woohaa3 3D 模型脚本使用确定性的 JavaScript。
脚本版本：${guide.preferredVersion}

${REFERENCE_GUIDE}


SceneBuilder 方法：
${methods}

坐标与朝向约定（对齐 glTF 2.0 行业惯例，务必遵守）：
- ${guide.conventions.up} 朝上、${guide.conventions.front} 为模型正面、${guide.conventions.left} 为模型左侧；
- rotation 使用${guide.conventions.rotationUnit === "degrees" ? "角度制" : "弧度制"}，按固定 ${guide.conventions.rotationOrder} 顺序组合；
- position/rotation/scale 相对 parent 的局部空间；父 group 的变换与动画会作用到全部后代；
- 画布使用 dimetric 等距视图：local +Z（正面）投影到屏幕“左下方、面向观察者”，
  local +X（左侧）投影到“右下方”；请把正面放在 +Z 一侧，背面放在 -Z。

尺度约定（模型按真实世界尺度渲染）：
- ${modelScaleGuidanceTextZh()}

新建人物/机器人/机甲必须优先使用 SOMA77 标准模板：
- 调用 scene.somaHumanoid({id:"pilot",style:"mecha",armorColor:"#cbd5d1",jointColor:"#17242c",accentColor:"#ed542c",lightColor:"#45d7ff"}) 即可生成完整可见机甲和77个官方SOMA关节。无需逐个搭建骨架，不要改为14关节，也不要自己重建77关节。
- 人物/机甲的一句话提示词应直接转为模板外观参数；保留用户指定颜色。不要仅返回解释或创建外部GLB链接。
- 返回 const human = scene.somaHumanoid(...)；human.root 是根组，human.joint("RightHand") / human.joint("LeftHand") 可用于附加装备的 parent，坐标相对官方关节绑定坐标轴。不要把 handle 命名为 rig，也不要混用旧 rig.joint。
- 模板固定骨架、绑定姿态和骨长；当前机甲装甲是绑定到关节的刚性可编辑部件，不宣称是官方白模的平滑蒙皮。SOMA兼容不表示已经接好Kimodo或导演区播放。
- 体型预设：scene.somaHumanoid({id:"actor",style:"humanoid",bodyPreset:"soma-body-v1/female-8-slim"}); 性别 male/female、头身比 7/8/9/10、体型 slim/fat 共16种成人，身高1.70米；另有 soma-body-v1/baby（婴儿0.70米）、soma-body-v1/{male|female}-child（男女童1.15米）和 soma-body-v1/{male|female}-teen（男女少年1.50米），年龄预设不分头身比或胖瘦。全部脚底Y=0，不能用于mecha。未指定bodyPreset保留旧标准白模/机甲。保存版本化ID，不改写已有作品。animate_humanoid 会核对真实目标绑定帧并适配源动作，源Kimodo资产与目标预设身份分别保留。
- 新建完整最小脚本：scene.somaHumanoid({id:"pilot",style:"mecha"}); 使用 submit_model_script 提交，画布和原生渲染器均通过普通Scene IR渲染。
- 修改已有SOMA模型时保留模板调用与id，在原脚本上修改外观参数或增加装备；禁止退化成无骨架散件。

旧版14关节模型兼容说明（仅用于编辑已有 rig.joint 作品，新建人形不要采用）：
- 系统已经有这 ${HUMANOID_V1_JOINT_IDS.length} 个关节：${HUMANOID_V1_JOINT_IDS.join("、")}。
- 每个可见形状用 rig.joint("LeftUpperLeg") 这类调用做 parent。不要把肢体挂到 Root，也不要自造 thigh、shin、Shoulder、Chest、Neck、Hand。
- 手和枪用 rig.joint("LeftHand") / rig.joint("RightHand")，它们是前臂挂点，不是关节。
- 关节原点就是髋、膝、肩、肘。position 以及 segment 的 from/to 是该关节的局部坐标，不是整个人的站立高度。
- 肢体从关节原点伸向子关节。左大腿用 parent: rig.joint("LeftUpperLeg")，from: [0, 0, 0]，to: [0, -0.4, 0]。左上臂平举到 [0.3, 0, 0]。禁止把 y=1.69 的头或 y=0.06 的脚再挂到关节上，局部坐标会叠到关节位移上，身体会散开。
- 腹部必须连上髋和脊柱。脊柱在髋上方 0.5 米，中间没有腰关节。不要只在 Hips 和 Spine 原点各放一个小盒子。用这一段填上：scene.segment({ id: "abdomen", parent: rig.joint("Spine"), from: [0, -0.5, 0], to: [0, 0, 0], width: 0.32, depth: 0.24, shape: "box" })。胸甲中心要低于头关节，头在 Spine 上方 0.25 米。
- 髋在模型原点，脚在负 Y。这是参考姿态。不要改关节位置来把脚挪到 y=0。
- 动作的 targetId 必须是上面的关节 id。原地跑步要给左右 UpperLeg、LowerLeg、Foot 各写不同的旋转轨道。工具返回成功不等于用了关节。
- 这条基准只描述模型自身的绝对尺寸；模型在世界中按真实尺度渲染，位置使用世界坐标，
  不要用节点矩形、画布 zoom 或聚焦取景反推单位。

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

无骨架连接示例（坐标相对模型原点，人形和机甲不要照搬这些绝对高度）：
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
