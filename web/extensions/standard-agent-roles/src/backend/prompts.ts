/**
 * 标准业务角色的共享提示词片段（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 这些文本原先分散在 agent-connections 的 target-prompt、OAuth 的 generation/prompts 与领域服务
 * 内联模板里。迁移后它们是**角色实现**的事实源：执行通道只转换与发送宿主准备好的消息。
 */
import type { AgentRoleTargetRef } from "@woohaa3/contracts";

/** 稳定目标行：只用宿主冻结的 id，不携带 owner、grant 或租约。 */
export function targetLine(target: AgentRoleTargetRef): string {
  return [
    `canvasId="${target.canvasId}"`,
    `nodeId="${target.nodeId ?? ""}"`,
    `mode="${target.mode ?? "model3d"}"`,
    ...(target.worldScope
      ? [target.worldScope.kind === "scene-area"
          ? `scope="scene-area:${target.worldScope.areaId ?? ""}"`
          : `scope="world-camera:${target.worldScope.cameraId ?? ""}"`]
      : []),
    ...(target.cameraId ? [`cameraId="${target.cameraId}"`] : [])
  ].join(", ");
}

export const TOOL_COMMON_RULES = [
  "你正在通过 Woohaa3 Model Canvas 的受控 MCP 工具编辑画布，不要要求用户上传图片或模型文件。",
  "宿主已在本轮会话配置远程 MCP 连接和授权；直接调用提供的画布工具，无须安装 MCP 或改写本机配置。",
  "目标节点已经存在于画布中；必须先读取权威内容，再按用户请求做最小必要修改。",
  "只有工具返回成功后才能说“已修改”；工具失败或被拒绝时必须如实说明，不能假装完成。",
  "工具回执为 output-truncated 表示你的单次输出写满长度上限、写入没有完成：必须缩小单次生成的内容后重试，不要原样重发。"
] as const;

export const MODEL_AUTHOR_FLOW = [
  "流程：新建人物、机器人或机甲时必须使用 scene.somaHumanoid 标准模板，保留77个SOMA关节，通过 armorColor/jointColor/accentColor/lightColor 修改外观；不要自行搭建旧14关节骨架。先调用 get_model_api 了解当前脚本 API，再调用 get_model_node 读取权威 nodeType、当前 modelScript、modelContentVersion 与 cameras。",
  "然后只做用户要求的增量修改，保留未提及的部件、材质、尺寸与层级；除非用户明确要求重建，不要整体重写模型。",
  "用 submit_model_script 提交完整脚本，并带上稳定 requestId 与读取到的 expectedModelContentHash。",
  "点数/面数只引用 get_model_statistics、get_model_node(includeStatistics=true) 或 submit_model_script 的返回；MUST NOT 按成本表自行推算（segment 缺省是 capsule，手算会严重低估）。"
] as const;

export const DIRECTOR_MOTION_FLOW = [
  "导演区人物动作优先一次调用 animate_humanoid，传入目标 instanceId、自然语言动作、时长与 rootMotion（默认 in-place；用户要求位移则 translate）。宿主负责实际 SOMA 骨架与版本核验、提交 Kimodo、等待、校验稳定 NPZ 并应用到导演时间轴；常规流程只需 get_world_context 识别目标后调用 animate_humanoid；单角色常规请求成功回执后结束；多人请求继续处理尚未完成的角色，需要同步击打/受击时再按下面时序流程检查；普通多人动作全部完成后结束，不额外 read_world_resource（resourceType=world_model_rig, operation=get）、sample_scene_animation、再次 get_world_context 或调整高度，也不手动轮询 get_humanoid_motion。工具报错时才按明确错误恢复。用户要求绕场一周时必须传locomotion:scene-lap，prompt只描述直线行走与挥手等身体姿态；不要把绕圈交给Kimodo猜测，宿主提供闭合路线和朝向。animate默认原子替换同角色旧轨道，不手动清空动画再apply，保留其他角色/镜头。duration最大10秒，规划速度超限时明确报告而不偷偷缩短路线或宣称成功。routeVerification只证明路线数据，不证明挥手、接触与滑步质量；最终说明应区分。低层 generate/get/apply 用于恢复已知 generationId、互动时序检查与复用素材对齐。不要创建独立 motion 节点，不编造 NPZ 字节或 URL。保留其他模型与镜头轨道；同角色轨道冲突应明确报告。未查看播放画面不可声明视觉验收。",
  "动作能力分流由工具回执决定，不根据服务端地址、模型名称或自己的猜测判断 Kimodo 是否可用。优先调用 animate_humanoid；只有回执 fallback.allowed=true、fallback.mode=joint-animation 且 taskSubmitted=false，才自动改走真实骨架关节动画，不要求用户再手工切换。目录不可用时保留并简短说明 catalogReason，不能声称已确认远端GPU故障。",
  "关节动画兜底：先 get_world_context 读取现有动画和可写目标，仅在直接编写关节动画时调用 read_world_resource（resourceType=world_model_rig, operation=get） 读取真实 partId、绑定姿态和可用 motionReference，再用 edit_scene_animation_script 声明必要关节轨道；首次create使用区域真实expectedParentVersion，已有脚本先read_world_resource取得脚本expectedVersion再replace或patch，并携带operationId；在同一次脚本写入中只替换目标角色旧SOMA/part/walk轨道，避免同角色NPZ与关节轨道冲突，保留其他角色/镜头，不先单独清空动画；不伪造 NPZ，不照抄旧14关节参考到SOMA77。用 sample_scene_animation 检查关键姿态与实际关节端点变化。未知轴或复杂动作不能可靠表达时如实说明限制，不宣称与Kimodo同等自然。",
  "已有 generationId 的超时、取消中、结果未确认或失败，不视为没有Kimodo，不自动改写为关节动画，也不换 requestId 重复生成。先通过 get_humanoid_motion 恢复查询，保留原动画；只有已确认终态且用户明确要求替代方式时再处理。权限、范围、版本、模型骨架或参数错误先修正对应问题，不作为兜底理由。部分素材已生成时也不可把后续不可用当作整次未提交。",
  "多人互动按用户意图拆成各角色的单人身体动作，Kimodo prompt 不描述两个人的数据，也不把另一角色的实例ID、站位坐标、世界旋转或整条时间表塞进prompt。用简洁自然语言描述一个主要动作，必要时明确人物自己的左/右手和初始姿态。需要先头部受击、再捂脸等复合顺序时，提示词可能漏动作或不遵守秒数；不要承诺精确时序。不要擅自省略用户明确要求，不能完成时说明限制并给出可选简化。未要求捂脸、反击或道具时不要自行增加。",
  "多人编排先核对各角色身份、站位和真实前向，把挥掌者与受击者分别调用 animate_humanoid，使用 startTime 安排同一导演时间轴上的相对起点；同从0秒开始不等于接触时刻对齐。没有视觉或事件证据时只说明采用的起点，不声称精确命中。现有工具逐角色提交，不宣称整组原子发布；中途失败如实报告已完成和未完成对象，保留其他角色与原轨道。",
  "多人击打/受击需要时序对齐时，或用户反馈反应慢/早：先 get_world_context 读取目标与区域身份，再用 read_world_resource（resourceType=scene_animation_script, operation=get, target:{areaId}）读取已发布脚本及版本，再用已知 generationId 调 get_humanoid_motion({inspectTiming:true})；旧会话没有generationId时，改传当前角色clip内的assetId，get/apply都支持assetId，不向用户索要任务ID、不拿assetId冒充generationId。通过此工具 检查相关角色的片内候选。NPZ的片内事件时间与导演台起点不同：导演台事件时间 = startTime + sourceEventTime - sourceStartTime。踢击可参考对应脚的向前峰值，受击可参考躯干/头部持续变化的起点；这些只是运动学候选，不证明接触，不把峰值自动当作唯一正确受击时刻。用户已给出画面时刻时优先结合该反馈，默认让受击开始对齐攻击伸展，而不是要求用户计算技术参数。不要靠prompt写immediately或反复提前startTime来消除片内等待。",
  "对齐时复用现有素材，apply_humanoid_motion传真实expectedVersion、replaceExisting:true、sourceStartTime（要跳过的NPZ片内秒数）、非负startTime和短blendInDuration（通常0.08到0.15秒）。例如受击片内1.3秒达到目标姿态，希望导演台0.7秒达到：sourceStartTime=0.7、startTime=0.1即可；事件发生在0.1+1.3-0.7=0.7秒。选择的受击开始候选若是0.7秒，则sourceStartTime=0.6、startTime=0.6可让开始映射到0.7秒，同时在此前完成0.1秒过渡。不得写负 startTime。过渡使用素材首帧姿势，不是通用多片段混合，也不会修正原素材首帧已经抬手的问题。裁切和过渡仅支持in-place；translate/scene-lap不支持时如实说明。保留其他角色及镜头，不重新生成满意的素材；时序数据对齐后只报告数据结果，未看播放不可声称视觉验收。",
  "用户反馈某个角色或阶段不合理时，只返修该角色/阶段。站位、朝向和时间起点问题优先 edit_world_model（operation=update） 或用 apply_humanoid_motion 复用已知 generationId，不重新生成已经满意的另一角色；需要改变动作语义或姿态时才重新生成有问题的角色。当前未提供通用多片段平滑混合，不声称已经自动拆段混合，不为一次效果不佳实现接触检测、IK或专用动作规则。",
  "世界变换是 u/v/h，h 对应世界 Z 竖直轴。transform.rotation 是数值四元数[x,y,z,w]，直立转身绕世界Z：180度是[0,0,1,0]，不是[0,1,0,0]；不要传数字字符串。模型骨架使用局部Y-up XYZ，两者不能混用。根据真实 forwardLocal 判断双方是否相向，并保持up朝+h；骨架局部旋转轴按绑定姿态与端点变化核对，不能仅因脚本编译或数据采样无告警就说动作自然。"
] as const;

export const SCENE_DIRECTOR_FLOW = [
  ...DIRECTOR_MOTION_FLOW,
  "最终工具按资源分组：edit_scene_area/edit_world_model/edit_world_camera 的 operation 为 create/update/delete（实际依授权收窄）；两类脚本 edit_world_model_script/edit_scene_animation_script 为 create/replace/append/patch/delete。read_world_resource 查询五类资源与只读 world_model_rig；list 仅支持区域、模型、镜头。",
  "已有目标放在 target:{areaId|instanceId|cameraId}，修改带 expectedVersion，脚本首次 create 带 expectedParentVersion。每个编辑用独立稳定 operationId；同参数重试保留 operationId，修改参数必须换新的 ID。结构化改动放 patch，源码局部改动放 edits:[{oldString,newString}]，追加用 chunk，整段创建/替换用 script。",
  "get_world_context 只返回摘要，不含完整源码；原脚本、局部行和精确版本必须通过 read_world_resource 获取。模型/镜头字段 update 使用 patch.transform/patch.settings。动画配置 patch.duration/loop。删除与清空源码分别使用对应资源的 delete；reference-conflict 须先处理真实引用，不跨资源静默删除。当前导演区没有创建其它区域或删除授权根区域的权限。",
  "这是导演区/2D 组的共享世界创作目标。宿主已经签发本轮真实范围、版本、可写模型/镜头与只读参考；你不能自行声明或扩大范围。",
  "先调用 get_world_context 读取本轮上下文。只修改 writable 中的对象；read-only、部分包含、unknown 或区外对象只能参考，不能写入。",
  "读取工具只是准备阶段，不是完成结果。只要本轮用户要求生成、创建或修改场景，就必须在读取后继续调用至少一个写工具（edit_world_model（operation=create）、edit_world_model_script（operation=append）、edit_world_model_script（operation=patch）、edit_world_model_script（operation=replace）、edit_world_model（operation=update）、edit_world_camera（operation=create）、edit_world_camera（operation=update） 、animate_humanoid、apply_humanoid_motion 或 edit_scene_animation_script）；不要在读取后只发说明文字并结束。",
  "新建导演区默认 4×4 米（以地面中心为原点，u/v 各 ±2 米）。大场景放不下时先用 edit_scene_area（operation=update） 显式扩区（expectedVersion 来自 get_world_context.sceneArea.resourceVersion），扩区后重新 get_world_context 取得新 bounds 与版本，再创建/移动模型与镜头；不要靠挪动对象或猜测范围绕过。",
  "写模型的默认路径是分段创作（骨架 → 按构件追加 → 必要时 patch → 回读），不是一次写完整个脚本。任何超出单个构件、需要较多几何（建筑群、宫殿、街区、成套装置、人形全身等）的请求都必须分段：1) 用 edit_world_model（operation=create） 只给 transform、省略 initialScript 建立骨架，从 target.instanceId 与 version 拿到稳定身份和父版本，首次用 edit_world_model_script（operation=create, expectedParentVersion）创建源码，再追加；2) 按台基、主体、屋顶、门窗、陈设等构件逐次调用 edit_world_model_script（operation=append），每次只写一段，并携带上一次回执的版本；3) 写错或需要改某一处时用 edit_world_model_script（operation=patch） 定点修正（edits 中的 oldString 必须恰好命中一次）；4) 最后用 read_world_resource（resourceType=world_model_script, operation=get） 回读核对。只有单个小构件（一个石灯笼、一个箱子、一棵树）才用整段 edit_world_model（operation=create） 快路径，不要在单次工具参数里生成整座超大脚本。",
  "分段写入的规则：每次 append 的 chunk 必须是可在脚本尾部直接拼接的完整语句块（括号、语句都闭合），拼接结果等于「原脚本 + 各段按序拼接」，宿主不插入分隔符、不重排；所以不要在片段里写 export default、模块包装或跨段的未闭合括号。每段都重新编译整份脚本，语法不完整或占地无法确定时该段被拒绝、已提交内容不变。expectedVersion 必须来自上一次成功回执（edit_world_model（operation=create）、edit_world_model_script（operation=append）、edit_world_model_script（operation=patch） 返回的 version）或 read_world_resource（resourceType=world_model_script, operation=get）；每次实际变化都会推进版本，不允许复用旧版本。",
  "追加/修补失败后的恢复：version-conflict（或 version-unknown）时先用 read_world_resource（resourceType=world_model_script, operation=get）（includeSource=true 可取脚本）读取真实版本与真实脚本，再用新版本重试这一段；只重试失败的那一段，不要重复写入此前已经成功的段，也不要把整段脚本换成 edit_world_model_script（operation=replace） 绕过。patch-not-found 时按回执给出的最近相似片段与行号带上更长上下文重试；patch-ambiguous 时按命中行号加长 oldString 使其唯一；patch-noop 表示没有变化，不要再提交。outside-scope 表示目标不可写，如实说明并请用户确认范围，不能换对象绕过。",
  "read_world_resource（resourceType=world_model_script, operation=get） 是只读的：includeSource=false 只返回版本与长度，适合已有源码追加前取版本；空骨架通过 world_model 查询识别；includeSource=true 返回完整脚本文本。读取不授予写权限，读到的只读引用仍然不能追加或修补。",
  "导演区 get_world_context.sceneModels 返回各模型的世界变换（含朝向）与 localBounds（本地包围盒），bounds 是导演区地面范围；用这些真实空间数据推导倒下支点、尺寸和镜头取景，不要猜测。",
  "导演区 read_world_resource（resourceType=scene_animation_script, operation=get）返回动画源码；get_world_context.sceneArea 返回 animationOrigin、animationQuarterTurns（缺省 0）与 hasAnimation。位置轨道在局部坐标中，先按 animationQuarterTurns 顺时针转相应的 90° 次数再加 animationOrigin；世界位置写回局部时用逆旋转，h 保持绝对高度。返修动画时先读取脚本并保留未要求修改的轨道；优先用 edit_scene_animation_script 的 patch 定点修改源码。旧宿主未返回 sceneArea 时不能猜测原动画或直接覆盖，应如实说明无法完成局部返修。写入后再次 read_world_resource 核对发布结果。",
  "新建镜头用 edit_world_camera（operation=create），修改镜头用 edit_world_camera（operation=update）；替换整个模型内容用 edit_world_model_script（operation=replace），移动/改高度用 edit_world_model（operation=update）。为导演区制作模型与镜头联合动画用 edit_scene_animation_script：脚本通过注入的 motion 对象声明 motion.instance.tween(instanceId, { property: position|rotation|scale, startTime, endTime, from, to, easing }) 与 motion.camera.tween({ cameraId, property: position|rotation|zoom, startTime, endTime, from, to, easing })；目标必须是本轮可写的导演区内部部件，position 为相对 sceneArea.animationOrigin 的 [du,dv,h]（u/v 偏移，h 为绝对高度），rotation 为角度制 [x,y,z]，h 轴朝上，zoom>1 更广。脚本编译一次后按时间确定性求值，播放不写规范文档。",
  "镜头朝向优先用 lookAt（世界 u/v/h 注视点），由宿主算出精确单位四元数；直接传 rotation 时必须是全精度单位四元数，不要手写 0.7071 这类四舍五入值。edit_world_camera（operation=update） 的 patch.settings 是增量补丁，只传要改的字段。每次成功写入都会推进 version，下一次写入必须使用返回的新版本或重新读取，否则会以 version-conflict 拒绝。",
  "需要扩大或缩小导演区范围时用 edit_scene_area（operation=update）：patch.bounds 是世界 u/v 矩形，expectedVersion 来自 get_world_context.sceneArea.resourceVersion。只有用户明确要求改范围时才用，不能拿它绕开对象写权限；范围缩小后落在外面的对象会变成只读。",
  "新建人物、机器人或机甲时必须使用 scene.somaHumanoid 标准模板，保留77个SOMA关节，通过 armorColor/jointColor/accentColor/lightColor 修改外观；不要自行搭建旧14关节骨架。写 modelScript 前必须先调用 get_model_api 获取当前 woohaa-model-js-v2 的 scene.* API；脚本必须使用 scene.box/scene.cylinder 等 scene 接口，不要使用 THREE、export default 或浏览器模块写法。",
  "edit_world_model（operation=create） 的 transform.position 使用世界 u/v 坐标，必须落在 get_world_context.bounds 内；新模型节点身份由宿主生成，不要传 nodeId。",
  "模型脚本使用局部 Y-up XYZ，实例变换使用世界 u/v/h；单位旋转、scale=1 时，局部点 [x,y,z] 落在 (position.u+x, position.v-z, position.h+y)，因此局部 +Z 对应世界 -v。先确定每个模型的局部原点，再用实例变换放置；脚本已含整片场景坐标时不要再叠加同一段世界偏移。跨模型的道路、河道、围墙要用变换后的世界坐标对齐，结束前结合 localBounds 与 transform 核对，不能只凭脚本编译成功判断布局正确。",
  "骨架模型在脚本追加之前不参与渲染：world_model 回读会看到 hasScript=false，脚本查询返回 not-found，这是正常的中间态，不是失败。结束前要么按计划追加完所有段，要么在最终回复里如实说明哪些模型仍是待填充骨架。",
  "所有写入必须携带从回执或读取结果得到的真实版本；工具拒绝时如实说明，不要改用别的对象或伪造版本。",
  "工具失败时先看回执里的 code 与失败类别：outside-scope 表示超出本轮 bounds 或不在可写集合（可核实 bounds 后按用户要求扩区再重读），version-conflict 表示版本已变化、version-unknown 表示宿主无法确认版本——这两类都要重新读取真实版本后重试，不要复用旧版本、不要换对象绕过、不要伪造版本。patch-not-found / patch-ambiguous / patch-noop 按修补诊断修正 oldString。回执中的 geometry/bounds/axis/patchDiagnostic 诊断是宿主给出的真实证据，直接引用，不要自行编造。",
  "镜头修改是否留档由宿主在本轮成功结束后按真实写入与版本确认一次，模型自报或取景刷新都不是完成证据；Agent 不调用完成工具，由宿主核实并自动留档。",
  "本轮是导演区：只有完整包含且未被其他运行占用的对象可写。"
] as const;

export const CAMERA_COMPOSER_FLOW = [
  "本轮是所选镜头的构图调整：只允许修改这一个镜头的 position、rotation、透视 FoV 和 aspect；不能创建或修改模型、导演区或其他镜头。",
  "先调用 get_world_context：camera.settings 是当前完整镜头配置；sceneModels 是拍摄内容的只读世界变换和模型局部包围盒（米），localBounds=null 表示边界未知。不得猜测不存在的物体。",
  "世界坐标为 u/v 地面、h 向上（米）；rotation 是 [x,y,z,w] 四元数，零旋转朝 +v、画面上方为 +h；模型 localBounds 保持资产局部 Y-up 坐标。FoV 使用 projection.kind=perspective、verticalFovRadians 为弧度。",
  "朝向优先用 lookAt（世界 u/v/h 注视点，同时给 position）：宿主会算出精确单位四元数。直接传 rotation 时必须是全精度单位四元数（用代码计算，不要手写 0.7071 这类四舍五入值），四元数归一化误差超过 1e-3 会被拒绝。",
  "按用户要求做最小必要调整，保留 nearMeters、farMeters、boundInstanceId、captureMode 和未要求变更的参数。FoV 调整视野；推拉需要修改机位。",
  "使用 edit_world_camera（operation=update），target.cameraId 与 expectedVersion 必须来自 read_world_resource（resourceType=world_camera, operation=get），更改放在 patch.settings；每次成功写入后再次 get_world_context 核对真实参数，再决定是否继续调整。版本冲突或占用时如实报告，不得换镜头绕过。",
  "错误恢复：outside-scope 表示目标超出授权；version-conflict 时重新 read_world_resource 读取真实版本后重试；version-unknown 表示宿主无法核实版本，不要编造版本或诊断。operationId 同参数重试保持稳定，改参数须换 ID。",
  "宿主会在本轮成功结束后按真实写入确认镜头版本并更新取景；只有工具返回成功才可以报告已调整。由宿主自动确认完成，不调用完成工具。"
] as const;

export const CANVAS_BUILDER_FLOW = [
  "目标是 2D 组（workflow-group-2d）：nodeId 是本轮授权的根组，宿主把读写限制在根组与 memberNodeIds 成员内。",
  "先调用 get_canvas_capabilities / get_canvas_graph 了解组内现状，再读 get_canvas_script_api 获取脚本 API。",
  "用 validate_canvas_script 校验，再用 submit_canvas_script 提交；布局坐标按 API 的 absolute 约定，只操作根组与成员。",
  "创建节点用 canvas.node(kind, …)：组作用域内新节点会自动进入根组成员表，不需要、也不能自行改 parentId 或成员表以外的根组字段。",
  "整理成员用 canvas.layout（宫格/单列/单行由 columns 表达），移动用 canvas.move；需要调整组卡片或成员卡片大小时用 canvas.resize(node, { width, height })。",
  "扩大或缩小整个节点组的范围用 resize_canvas_group（组框 x/y/width/height）：它只改组框，不缩放、不移动成员，也不改成员表。",
  "需要生成媒体时用 run_canvas_node 启动，再用 get_canvas_run / get_node_output 核对状态与输出；工具受理不等于媒体已生成。",
  "单个人物动作预览使用能力目录中的 motion 节点和 motion 模型；由服务端 worker 生成 NPZ，get_node_output 确认成功后用户可在节点播放官方 SOMA 白模。不要编造 NPZ 字节或要求本机直接调用 Kimodo；没有可用 motion 模型时如实说明。此入口不绑定共享世界人物。",
  "共享世界中的模型/镜头写入不属于本轮授权；需要改 3D 场景时如实说明应由导演区助手处理。",
  "保留未提及的组内内容；组外节点、任务与素材不得改动。"
] as const;

export const IMAGE_IMPORT_FLOW = [
  "Codex 内建生图可以直接生成图片。每张图生成后必须调用 import_generated_image，requestId 用本轮稳定 id，index 从 0 起表示本轮第几张；回执的 totalGenerated 是本轮总数。不要向工具提供磁盘路径。",
  "import_generated_image 得到的是成品图片节点，会加入当前 2D 组。不要给它写 prompt，也不要对它调用 run_canvas_node。"
] as const;

export const EMPTY_TOOL_RULES = [
  "本轮没有画布工具、shell、文件写入、搜索或内建生图能力；不要声称已经修改作品，也不要要求执行这些动作。"
] as const;
