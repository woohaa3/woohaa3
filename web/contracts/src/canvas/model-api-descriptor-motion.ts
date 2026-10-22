/**
 * `woohaa-motion-js-v1` 运动作者 API descriptor 与指南
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.4）。
 *
 * 单一事实来源：MCP 与作者指南的方法集合、单位说明与最小示例都由这里生成，避免文档与
 * executor 漂移。指南只描述运动中可用的接口，不重复模型几何方法（模型 API 见
 * `model-api-descriptor`）。
 */
import {
  MOTION_SCRIPT_LANGUAGE,
  MOTION_SCRIPT_VERSION,
  SUPPORTED_MOTION_SCRIPT_VERSIONS
} from "./motion-script.js";
import {
  MOTION_IR_VERSION,
  MOTION_MAX_CAMERA_TRACKS,
  MOTION_MAX_DURATION_SECONDS,
  MOTION_MAX_MODEL_TRACKS,
  MOTION_MAX_TRACKS,
  MOTION_MAX_KEYFRAMES_PER_TRACK
} from "./motion-ir.js";

/** 运动坐标 / 时间单位与朝向约定。 */
export const MOTION_API_CONVENTIONS = {
  timeUnit: "seconds",
  angleUnit: "radians",
  speedUnit: "radians per second (rotate) / world units per second (move)",
  phaseUnit: "radians",
  axisDefault: "y",
  modeDefault: "position",
  easingDefault: "linear",
  defaultStartTime: 0,
  defaultEndTime: "timeline duration",
  cameraTarget: "本动画节点保存的初始镜头",
  modelTarget: "顶层动作用 modelScript 声明的稳定部件 id；片场对象动作的 root 表示该 itemId 的整个人物，其他 partId 只引用该对象自身部件",
  modelProperties: "position/rotation/scale；position 为相对基础摆放的局部位移，rotation 为局部 Y-X-Z 弧度，scale 为基础缩放的乘数",
  modelIntervals: "同一目标同一属性的区间不得重叠；不同属性可同时运动，相接片段可串联；后一片段开始时接管，结束后保持终值",
  keyframeTime: "对象局部时间（秒），frames 的首末 time 默认为 startTime/endTime；每个点的 easing 控制到下一个点的插值"
} as const;

/** 一个 motion API 方法签名。 */
export type MotionApiMethod = {
  name: string;
  signature: string;
};

/** 运动方法集合（与 `MotionRecorder` 的实现一一对应）。 */
export const MOTION_API_METHODS: readonly MotionApiMethod[] = [
  { name: "model.tween", signature: "motion.model.tween(targetId, { id?, property: 'position'|'rotation'|'scale', from: [x,y,z], to: [x,y,z], startTime?, endTime?, easing?: 'linear'|'smoothstep' }) => id" },
  { name: "model.keyframes", signature: "motion.model.keyframes(targetId, { id?, property: 'position'|'rotation'|'scale', frames: [{ time, value: [x,y,z], easing? }], startTime?, endTime?, easing? }) => id" },
  { name: "camera.tween", signature: "motion.camera.tween({ id?, property, startTime?, endTime?, from, to, easing? }) => id" },
  { name: "model.rotate", signature: "motion.model.rotate(targetId, { id?, axis?, speed, startTime?, endTime? }) => id" },
  { name: "model.move", signature: "motion.model.move(targetId, { id?, axis?, speed, range, startTime?, endTime? }) => id" },
  {
    name: "model.oscillate",
    signature: "motion.model.oscillate(targetId, { id?, axis?, mode?, speed, amplitude, phase?, startTime?, endTime? }) => id"
  }
];

/**
 * 指南里的最小运动示例（模型脚本见 `model-api-descriptor` 的 HUMAN_FIXTURE_SCRIPT）。
 *
 * 4 秒时间线：第 2 秒时身体已转动 2 秒、左手已摆动 1 秒、镜头按同一时间线计算。
 */
export const MOTION_FIXTURE_SCRIPT = `motion.camera.tween({
  id: "camera-orbit",
  property: "azimuth",
  startTime: 0,
  endTime: 4,
  from: 0,
  to: 1.57,
  easing: "smoothstep"
});

motion.model.rotate("body", {
  id: "body-turn",
  axis: "y",
  speed: 0.5,
  startTime: 0,
  endTime: 4
});

motion.model.oscillate("left-hand", {
  id: "hand-wave",
  axis: "z",
  mode: "rotation",
  speed: 6,
  amplitude: 0.4,
  phase: 0,
  startTime: 1,
  endTime: 4
});`;

export type MotionApiGuide = {
  language: typeof MOTION_SCRIPT_LANGUAGE;
  version: typeof MOTION_SCRIPT_VERSION;
  supportedVersions: readonly string[];
  irVersion: typeof MOTION_IR_VERSION;
  conventions: typeof MOTION_API_CONVENTIONS;
  methods: readonly MotionApiMethod[];
  limits: {
    maxCameraTracks: number;
    maxModelTracks: number;
    maxTracks: number;
    maxDurationSeconds: number;
    maxKeyframesPerTrack: number;
  };
  example: string;
  authoringRules: readonly string[];
  parkourExample: string;
};

/** 结构化运动 API 指南（由 MCP 渲染为文本，测试据此比对方法集合）。 */
export function motionApiGuide(): MotionApiGuide {
  return {
    language: MOTION_SCRIPT_LANGUAGE,
    version: MOTION_SCRIPT_VERSION,
    supportedVersions: SUPPORTED_MOTION_SCRIPT_VERSIONS,
    irVersion: MOTION_IR_VERSION,
    conventions: MOTION_API_CONVENTIONS,
    methods: MOTION_API_METHODS,
    limits: {
      maxCameraTracks: MOTION_MAX_CAMERA_TRACKS,
      maxModelTracks: MOTION_MAX_MODEL_TRACKS,
      maxTracks: MOTION_MAX_TRACKS,
      maxDurationSeconds: MOTION_MAX_DURATION_SECONDS,
      maxKeyframesPerTrack: MOTION_MAX_KEYFRAMES_PER_TRACK
    },
    example: MOTION_FIXTURE_SCRIPT,
    authoringRules: MOTION_AUTHORING_RULES,
    parkourExample: PARKOUR_MOTION_SCRIPT
  };
}

/** 运动方法名集合（一致性测试据此比对指南文本）。 */
export function motionApiMethodNames(): string[] {
  return MOTION_API_METHODS.map((method) => method.name);
}


export const MOTION_AUTHORING_RULES = [
  "一个人物在整段动作中保持同一 itemId/部件 id，只创建一套静态几何。严禁按时间复制人物并通过缩放或显隐轮换来模拟连续运动。",
  "定点移动、跳跃、落地和停住使用 model.tween/keyframes(position)；model.move 是循环移动，不能用它表达单次到达。",
  "修改已有片场人物时，用 mutate_film_set_item(kind=motion, itemId=现有对象, motionScript, playback)，整个人物的 targetId 用 root；摆放坐标与缩放由应用叠加处理。",
  "动作与几何独立：只修改 motionScript/playback，不因路径、时间线、镜头变化重写模型或追加人物；非循环 playback.loop=false 且 duration 覆盖末帧。",
  "位置、转身、缩放可以同时进行，但同目标同属性片段不能重叠；相接片段的 from 应等于上一段 to，路径关键点应连续。",
  "能力不足或校验失败时报告具体原因，保留已有场景；不要通过复制大量网格绕过动作限制。"
] as const;

/** 片场人物 child motion；root 映射到该 itemId 的作用域根。只增加小量轨道。 */
export const PARKOUR_MOTION_SCRIPT = `motion.model.keyframes("root", {
  property: "position",
  frames: [
    { time: 0, value: [0, 0, 0] },
    { time: 2, value: [4, 0, 0] },
    { time: 3, value: [6, 3, 0] },
    { time: 4, value: [8, 1, 0] },
    { time: 6, value: [12, 1, 0] },
    { time: 7, value: [14, 5, 0] },
    { time: 8, value: [16, 3, 0] }
  ]
});
motion.model.tween("root", {
  property: "rotation", from: [0, 0, 0], to: [0, 1.57, 0],
  startTime: 6, endTime: 8, easing: "smoothstep"
});`;

/** MCP 与 ChatGPT 共用完整的动作能力说明。 */
export function motionApiGuideText(): string {
  const guide = motionApiGuide();
  return [
    `运动脚本 ${guide.version}（与几何分离；静态模型不含动画）`,
    ...guide.methods.map(method => method.signature),
    ...Object.entries(guide.conventions).map(([name, value]) => `${name}: ${value}`),
    ...guide.authoringRules,
    `每条轨道最多 ${guide.limits.maxKeyframesPerTrack} 个关键帧；最多 ${guide.limits.maxModelTracks} 条模型轨道。`,
    "片场单人物跑酷示例（通过 mutate_film_set_item 写到对应 itemId 的 child motion，playback.duration=8、loop=false）：",
    guide.parkourExample
  ].join("\n");
}
