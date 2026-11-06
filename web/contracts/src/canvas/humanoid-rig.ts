/**
 * Humanoid V1 关节契约
 * （change: 2026-10-23-add-template-model-rigs，任务 1.2 / 1.4）。
 *
 * 模板工厂拥有 14 个关节的父子链和参考姿态。脚本执行、内容哈希和写入边界都读这里。
 * 坐标：Y 向上、+Z 朝前、角色左侧为 +X。参考姿态是直立 T-pose，关节旋转为 0°。
 * 1 场景单位 = 1 米。descriptor 里的参考旋转用角度，与几何作者一致。
 */
import { isFiniteNumber, isJsonObject } from "../validation.js";
import { fnv1a64Hex } from "./content-hash.js";
import { SCENE_IR_V2_COORD_LIMIT } from "./scene-ir-v2/types.js";
import { composeTransform, quatRotate, transformOf, transformPoint, type Quat, type Transform, type Vec3 } from "./model-transform.js";

/** 短于场景 segment 下限的骨头视为退化。 */
export const HUMANOID_LENGTH_EPSILON = 1e-4;
export const HUMANOID_TEMPLATE_ID = "humanoid";
export const HUMANOID_TEMPLATE_VERSION = 1;

export const HUMANOID_V1_JOINT_IDS = [
  "Root",
  "Hips",
  "Spine",
  "Head",
  "LeftUpperArm",
  "LeftLowerArm",
  "RightUpperArm",
  "RightLowerArm",
  "LeftUpperLeg",
  "LeftLowerLeg",
  "LeftFoot",
  "RightUpperLeg",
  "RightLowerLeg",
  "RightFoot"
] as const;

export const HUMANOID_PARAMETER_KEYS = [
  "pelvisWidth",
  "shoulderWidth",
  "torsoHeight",
  "headOffset",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftFoot",
  "rightFoot"
] as const;

/** 成人比例的参考尺寸。脚本第一次使用 rig.joint 且节点还没有骨架时写入这份。 */
export const HUMANOID_REFERENCE_PARAMETERS: HumanoidParameters = {
  pelvisWidth: 0.4,
  shoulderWidth: 0.6,
  torsoHeight: 0.5,
  headOffset: 0.25,
  leftUpperArm: 0.3,
  rightUpperArm: 0.28,
  leftLowerArm: 0.25,
  rightLowerArm: 0.24,
  leftUpperLeg: 0.4,
  rightUpperLeg: 0.4,
  leftLowerLeg: 0.35,
  rightLowerLeg: 0.35,
  leftFoot: 0.2,
  rightFoot: 0.2
};

export type HumanoidJointId = (typeof HUMANOID_V1_JOINT_IDS)[number];
export type HumanoidParameterKey = (typeof HUMANOID_PARAMETER_KEYS)[number];
export type HumanoidParameters = Record<HumanoidParameterKey, number>;

export type RigDiagnostic = {
  stage: "template" | "binding";
  code:
    | "missing-parameter"
    | "degenerate-parameter"
    | "non-finite-parameter"
    | "unknown-template"
    | "profile-not-humanoid"
    | "reserved-override"
    | "unknown-field"
    | "invalid-joint"
    | "unbound-shape"
    | "root-binding"
    | "torso-gap";
  path: string;
  expected: string;
  actual: string;
};

export type CompiledJoint = {
  id: HumanoidJointId;
  parent: HumanoidJointId | null;
  position: Vec3;
  /** 参考姿态旋转，角度。 */
  rotation: Vec3;
  scale: Vec3;
  /** 脚长。其它关节的长度已经体现在子关节位置里。 */
  length: number | null;
};

export type CompiledSocket = {
  id: "LeftHand" | "RightHand";
  parent: "LeftLowerArm" | "RightLowerArm";
  position: Vec3;
};

export type CompiledHumanoid = {
  joints: CompiledJoint[];
  sockets: CompiledSocket[];
};

export type HumanoidCompileResult =
  | ({ ok: true } & CompiledHumanoid)
  | { ok: false; diagnostics: RigDiagnostic[] };

export type HumanoidDecodeResult =
  | { ok: true; parameters: HumanoidParameters }
  | { ok: false; diagnostics: RigDiagnostic[] };

const PARENTS: Record<HumanoidJointId, HumanoidJointId | null> = {
  Root: null,
  Hips: "Root",
  Spine: "Hips",
  Head: "Spine",
  LeftUpperArm: "Spine",
  LeftLowerArm: "LeftUpperArm",
  RightUpperArm: "Spine",
  RightLowerArm: "RightUpperArm",
  LeftUpperLeg: "Hips",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  RightUpperLeg: "Hips",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg"
};

const DESCRIPTOR_KEYS = new Set(["profile", "templateId", "templateVersion", "parameters"]);
const PARAMETER_KEY_SET = new Set<string>(HUMANOID_PARAMETER_KEYS);
const SHAPE_TARGETS = new Set<string>([
  ...HUMANOID_V1_JOINT_IDS.filter((id) => id !== "Root"),
  "LeftHand",
  "RightHand"
]);

function issue(
  code: RigDiagnostic["code"],
  path: string,
  expected: string,
  actual: string,
  stage: RigDiagnostic["stage"] = "template"
): RigDiagnostic {
  return { stage, code, path, expected, actual };
}

function validateParameters(input: unknown): { ok: true; value: HumanoidParameters } | { ok: false; diagnostics: RigDiagnostic[] } {
  if (!isJsonObject(input)) {
    return { ok: false, diagnostics: [issue("missing-parameter", "parameters", "对象", String(input))] };
  }
  const diagnostics: RigDiagnostic[] = [];
  for (const key of Object.keys(input)) {
    if (!PARAMETER_KEY_SET.has(key)) {
      diagnostics.push(issue("unknown-field", `parameters.${key}`, "已知尺寸", key));
    }
  }
  const value = {} as HumanoidParameters;
  for (const key of HUMANOID_PARAMETER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      diagnostics.push(issue("missing-parameter", `parameters.${key}`, "有限正数", "缺失"));
      continue;
    }
    const raw = input[key];
    if (!isFiniteNumber(raw)) {
      diagnostics.push(issue("non-finite-parameter", `parameters.${key}`, "有限正数", String(raw)));
      continue;
    }
    if (raw <= HUMANOID_LENGTH_EPSILON || raw > SCENE_IR_V2_COORD_LIMIT) {
      diagnostics.push(issue("degenerate-parameter", `parameters.${key}`, `大于 ${HUMANOID_LENGTH_EPSILON} 且不超过场景坐标上限`, String(raw)));
    } else {
      value[key] = raw;
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value };
}

/** 把合法尺寸编译成 14 个关节和两个前臂挂点。相同输入得到相同数组。 */
export function compileHumanoidRig(parameters: HumanoidParameters): HumanoidCompileResult {
  const validated = validateParameters(parameters);
  if (!validated.ok) return validated;
  const size = validated.value;
  const position: Record<HumanoidJointId, Vec3> = {
    Root: [0, 0, 0],
    Hips: [0, 0, 0],
    Spine: [0, size.torsoHeight, 0],
    Head: [0, size.headOffset, 0],
    LeftUpperArm: [size.shoulderWidth / 2, 0, 0],
    LeftLowerArm: [size.leftUpperArm, 0, 0],
    RightUpperArm: [-size.shoulderWidth / 2, 0, 0],
    RightLowerArm: [-size.rightUpperArm, 0, 0],
    LeftUpperLeg: [size.pelvisWidth / 2, 0, 0],
    LeftLowerLeg: [0, -size.leftUpperLeg, 0],
    LeftFoot: [0, -size.leftLowerLeg, 0],
    RightUpperLeg: [-size.pelvisWidth / 2, 0, 0],
    RightLowerLeg: [0, -size.rightUpperLeg, 0],
    RightFoot: [0, -size.rightLowerLeg, 0]
  };
  const length: Record<HumanoidJointId, number | null> = {
    Root: null,
    Hips: null,
    Spine: null,
    Head: null,
    LeftUpperArm: null,
    LeftLowerArm: null,
    RightUpperArm: null,
    RightLowerArm: null,
    LeftUpperLeg: null,
    LeftLowerLeg: null,
    LeftFoot: size.leftFoot,
    RightUpperLeg: null,
    RightLowerLeg: null,
    RightFoot: size.rightFoot
  };
  return {
    ok: true,
    joints: HUMANOID_V1_JOINT_IDS.map((id) => ({
      id,
      parent: PARENTS[id],
      position: position[id],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      length: length[id]
    })),
    sockets: [
      { id: "LeftHand", parent: "LeftLowerArm", position: [size.leftLowerArm, 0, 0] },
      { id: "RightHand", parent: "RightLowerArm", position: [-size.rightLowerArm, 0, 0] }
    ]
  };
}

/** 严格读取 humanoid descriptor。多出来的关节表、父链或挂点一律拒绝。 */
export function decodeHumanoidRig(input: unknown): HumanoidDecodeResult {
  if (!isJsonObject(input)) {
    return { ok: false, diagnostics: [issue("unknown-template", "", "humanoid descriptor", String(input))] };
  }
  const diagnostics: RigDiagnostic[] = [];
  for (const key of Object.keys(input)) {
    if (DESCRIPTOR_KEYS.has(key)) continue;
    diagnostics.push(issue(
      key === "joints" || key === "sockets" || key === "parents" ? "reserved-override" : "unknown-field",
      key,
      "profile、templateId、templateVersion、parameters",
      key
    ));
  }
  if (input.profile !== HUMANOID_TEMPLATE_ID) {
    diagnostics.push(issue("profile-not-humanoid", "profile", HUMANOID_TEMPLATE_ID, String(input.profile)));
  }
  if (input.templateId !== HUMANOID_TEMPLATE_ID || input.templateVersion !== HUMANOID_TEMPLATE_VERSION) {
    diagnostics.push(issue(
      "unknown-template",
      "templateVersion",
      `${HUMANOID_TEMPLATE_ID} v${HUMANOID_TEMPLATE_VERSION}`,
      `${String(input.templateId)} v${String(input.templateVersion)}`
    ));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const parameters = validateParameters(input.parameters);
  if (!parameters.ok) return parameters;
  return { ok: true, parameters: parameters.value };
}

/** 用参考姿态加上可选的关节局部旋转（角度）求世界位置。旋转不移动该关节自己的原点。 */
export function jointWorldPositions(
  compiled: CompiledHumanoid,
  rotations: Partial<Record<HumanoidJointId, Vec3>> = {}
): Record<HumanoidJointId, Vec3> {
  const worlds = new Map<HumanoidJointId, ReturnType<typeof transformOf>>();
  const positions = {} as Record<HumanoidJointId, Vec3>;
  for (const joint of compiled.joints) {
    const local = transformOf({
      position: joint.position,
      rotation: rotations[joint.id] ?? joint.rotation,
      scale: joint.scale
    });
    const world = joint.parent === null ? local : composeTransform(worlds.get(joint.parent)!, local);
    worlds.set(joint.id, world);
    positions[joint.id] = [...world.translation];
  }
  return positions;
}

/** 每个人形可见形状必须挂到除 Root 以外的关节，或前臂上的手部 socket。 */
export function validateHumanoidBindings(
  _compiled: CompiledHumanoid,
  shapes: readonly { id: string; jointId: string | null }[]
): { ok: true } | { ok: false; diagnostics: RigDiagnostic[] } {
  const diagnostics: RigDiagnostic[] = [];
  shapes.forEach((shape, index) => {
    const path = `shapes[${index}].jointId`;
    if (shape.jointId === null || shape.jointId === "") {
      diagnostics.push(issue("unbound-shape", path, "关节或手部 socket", "缺失", "binding"));
      return;
    }
    if (shape.jointId === "Root") {
      diagnostics.push(issue("root-binding", path, "肢体关节或手部 socket", "Root", "binding"));
      return;
    }
    if (!SHAPE_TARGETS.has(shape.jointId)) {
      diagnostics.push(issue("invalid-joint", path, "已知关节或手部 socket", shape.jointId, "binding"));
    }
  });
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true };
}

export type StoredHumanoidRig = {
  profile: "humanoid";
  templateId: "humanoid";
  templateVersion: 1;
  parameters: HumanoidParameters;
};

const SOLID_OPS = new Set(["box", "cylinder", "sphere", "capsule", "segment", "mesh"]);

/** 参与内容哈希的稳定骨架键。参数顺序固定。 */
export function humanoidRigCanonical(parameters: HumanoidParameters): string {
  return ["humanoid", "1", ...HUMANOID_PARAMETER_KEYS.map((key) => `${key}=${parameters[key]}`)].join("\u0000");
}

/** 骨架身份。纯外观编辑不改变它；尺寸或模板版本会改变它。 */
export function humanoidRigSignature(parameters: HumanoidParameters): string {
  return fnv1a64Hex(`woohaa-humanoid-rig-v1\u0000${humanoidRigCanonical(parameters)}`);
}

export function storedHumanoidRig(
  input: unknown
): { ok: true; value: StoredHumanoidRig } | { ok: false; diagnostics: RigDiagnostic[] } {
  const decoded = decodeHumanoidRig(input);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    value: {
      profile: "humanoid",
      templateId: HUMANOID_TEMPLATE_ID,
      templateVersion: HUMANOID_TEMPLATE_VERSION,
      parameters: decoded.parameters
    }
  };
}

/** 关节与手部 socket 在 Scene IR 里的 group。父关节排在子关节前面。 */
export function humanoidSceneOps(compiled: CompiledHumanoid): {
  t: "group";
  id: string;
  parent: string | null;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}[] {
  return [
    ...compiled.joints.map((joint) => ({
      t: "group" as const,
      id: joint.id,
      parent: joint.parent,
      position: joint.position,
      rotation: joint.rotation,
      scale: joint.scale
    })),
    ...compiled.sockets.map((socket) => ({
      t: "group" as const,
      id: socket.id,
      parent: socket.parent,
      position: socket.position,
      rotation: [0, 0, 0] as Vec3,
      scale: [1, 1, 1] as Vec3
    }))
  ];
}

/** 人形动作允许的 targetId：14 个关节和两个手部 socket。 */
export function humanoidMotionTargetIds(compiled: CompiledHumanoid): Set<string> {
  return new Set<string>([...compiled.joints.map((joint) => joint.id), ...compiled.sockets.map((socket) => socket.id)]);
}

/** 脚本 op 不得占用骨架 id。 */
export function scriptOverridesReservedIds(
  ops: readonly { id?: unknown }[],
  compiled: CompiledHumanoid
): { ok: true } | { ok: false; diagnostics: RigDiagnostic[] } {
  const reserved = humanoidMotionTargetIds(compiled);
  const diagnostics: RigDiagnostic[] = [];
  for (const op of ops) {
    if (typeof op.id === "string" && reserved.has(op.id)) {
      diagnostics.push(issue("reserved-override", op.id, "几何使用独立 id", op.id));
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true };
}

/**
 * 每个可见实体都必须挂到除 Root 以外的关节或手部 socket。
 * 中间几何 group 可以存在，只要顺着 parent 能走到合法目标。
 */
export function validateHumanoidScene(
  compiled: CompiledHumanoid,
  ops: readonly { t?: unknown; id?: unknown; parent?: unknown }[]
): { ok: true } | { ok: false; diagnostics: RigDiagnostic[] } {
  const targets = new Set<string>([
    ...compiled.joints.filter((joint) => joint.id !== "Root").map((joint) => joint.id),
    ...compiled.sockets.map((socket) => socket.id)
  ]);
  const parentOf = new Map<string, string | null>();
  for (const op of ops) {
    if (typeof op.id !== "string") continue;
    parentOf.set(op.id, typeof op.parent === "string" && op.parent !== "" ? op.parent : null);
  }
  const diagnostics: RigDiagnostic[] = [];
  ops.forEach((op, index) => {
    if (typeof op.t !== "string" || !SOLID_OPS.has(op.t) || typeof op.id !== "string") return;
    const seen = new Set<string>();
    let cursor: string | null = typeof op.parent === "string" && op.parent !== "" ? op.parent : null;
    let bound: string | null = null;
    while (cursor !== null && !seen.has(cursor)) {
      if (targets.has(cursor)) {
        bound = cursor;
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    if (bound === null) {
      const actual = op.parent === "Root" || op.parent === null || op.parent === undefined ? String(op.parent ?? "缺失") : String(op.parent);
      diagnostics.push(issue(
        op.parent === "Root" ? "root-binding" : op.parent == null || op.parent === "" ? "unbound-shape" : "invalid-joint",
        `ops[${index}].parent`,
        "肢体关节或手部 socket",
        actual,
        "binding"
      ));
    }
  });
  if (diagnostics.length === 0 && torsoGap(compiled, ops)) {
    diagnostics.push(issue(
      "torso-gap",
      "Spine",
      "形体盖住髋到脊柱的中段",
      "髋与脊柱之间中空",
      "binding"
    ));
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true };
}

const TORSO_GAP_SLACK = 0.04;

type CoverOp = {
  t?: unknown;
  id?: unknown;
  parent?: unknown;
  position?: unknown;
  rotation?: unknown;
  scale?: unknown;
  size?: unknown;
  radius?: unknown;
  height?: unknown;
  from?: unknown;
  to?: unknown;
  width?: unknown;
  depth?: unknown;
  vertices?: unknown;
};

/** 髋到脊柱的中段必须被某个形体盖住。只在两个关节原点放盒子会留下空腰。 */
function torsoGap(compiled: CompiledHumanoid, ops: readonly CoverOp[]): boolean {
  const worlds = jointWorldPositions(compiled);
  const samples = [0.4, 0.5, 0.6].map((t) => lerpVec3(worlds.Hips, worlds.Spine, t));
  const byId = new Map<string, CoverOp>();
  for (const op of ops) if (typeof op.id === "string") byId.set(op.id, op);
  const cache = new Map<string, Transform>();
  const worldOf = (id: string, seen = new Set<string>()): Transform => {
    const cached = cache.get(id);
    if (cached) return cached;
    const op = byId.get(id);
    const local = transformOf({
      position: vec3(op?.position, [0, 0, 0]),
      rotation: vec3(op?.rotation, [0, 0, 0]),
      scale: vec3(op?.scale, [1, 1, 1])
    });
    const parentId = typeof op?.parent === "string" && op.parent !== "" ? op.parent : null;
    const world = !parentId || seen.has(id) ? local : composeTransform(worldOf(parentId, new Set(seen).add(id)), local);
    cache.set(id, world);
    return world;
  };
  return samples.some((sample) => !ops.some((op) => coversPoint(op, sample, worldOf)));
}

function coversPoint(op: CoverOp, point: Vec3, worldOf: (id: string) => Transform): boolean {
  if (typeof op.t !== "string" || !SOLID_OPS.has(op.t)) return false;
  const parent = typeof op.parent === "string" && op.parent !== "" ? worldOf(op.parent) : transformOf({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  if (op.t === "segment") {
    const from = vec3(op.from, null);
    const to = vec3(op.to, null);
    if (!from || !to) return false;
    const thickness = Math.max(num(op.width), num(op.depth)) / 2 + TORSO_GAP_SLACK;
    return distanceToSegment(point, transformPoint(parent, from), transformPoint(parent, to)) <= thickness;
  }
  if (typeof op.id !== "string") return false;
  const local = inverseTransformPoint(worldOf(op.id), point);
  if (op.t === "box") {
    const size = vec3(op.size, [0, 0, 0]);
    return local.every((value, index) => Math.abs(value) <= size[index] / 2 + TORSO_GAP_SLACK);
  }
  if (op.t === "sphere") return Math.hypot(...local) <= num(op.radius) + TORSO_GAP_SLACK;
  if (op.t === "cylinder" || op.t === "capsule") {
    const radius = num(op.radius);
    const half = Math.max(0, num(op.height) / 2 - (op.t === "capsule" ? radius : 0));
    return Math.hypot(local[0], local[2]) <= radius + TORSO_GAP_SLACK && Math.abs(local[1]) <= half + radius + TORSO_GAP_SLACK;
  }
  if (op.t === "mesh" && Array.isArray(op.vertices) && op.vertices.length > 0) {
    const points = op.vertices.map((vertex) => vec3(vertex, null)).filter((vertex): vertex is Vec3 => vertex !== null);
    if (points.length === 0) return false;
    return local.every((value, index) => {
      const values = points.map((vertex) => vertex[index]);
      return value >= Math.min(...values) - TORSO_GAP_SLACK && value <= Math.max(...values) + TORSO_GAP_SLACK;
    });
  }
  return false;
}

function inverseTransformPoint(transform: Transform, point: Vec3): Vec3 {
  const delta: Vec3 = [
    point[0] - transform.translation[0],
    point[1] - transform.translation[1],
    point[2] - transform.translation[2]
  ];
  const rotation: Quat = [-transform.rotation[0], -transform.rotation[1], -transform.rotation[2], transform.rotation[3]];
  const unrotated = quatRotate(rotation, delta);
  return [
    transform.scale[0] === 0 ? 0 : unrotated[0] / transform.scale[0],
    transform.scale[1] === 0 ? 0 : unrotated[1] / transform.scale[1],
    transform.scale[2] === 0 ? 0 : unrotated[2] / transform.scale[2]
  ];
}

function distanceToSegment(point: Vec3, from: Vec3, to: Vec3): number {
  const edge: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length2 = edge[0] ** 2 + edge[1] ** 2 + edge[2] ** 2;
  const start: Vec3 = [point[0] - from[0], point[1] - from[1], point[2] - from[2]];
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, (start[0] * edge[0] + start[1] * edge[1] + start[2] * edge[2]) / length2));
  return Math.hypot(start[0] - edge[0] * t, start[1] - edge[1] * t, start[2] - edge[2] * t);
}

function lerpVec3(from: Vec3, to: Vec3, t: number): Vec3 {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

function vec3(value: unknown, fallback: Vec3): Vec3;
function vec3(value: unknown, fallback: null): Vec3 | null;
function vec3(value: unknown, fallback: Vec3 | null): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every(isFiniteNumber)) return fallback;
  return [value[0], value[1], value[2]];
}

function num(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

/** 脚本是否调用了宿主注入的关节句柄。注释里的同名文字不会匹配。 */
export function scriptUsesHumanoidRig(source: string): boolean {
  return /\brig\s*\.\s*joint\s*\(/.test(source);
}

export function referenceHumanoidRig(parameters: HumanoidParameters = HUMANOID_REFERENCE_PARAMETERS) {
  return storedHumanoidRig({
    profile: "humanoid",
    templateId: HUMANOID_TEMPLATE_ID,
    templateVersion: HUMANOID_TEMPLATE_VERSION,
    parameters
  });
}

/**
 * 决定这次写入要保存的骨架。
 * 已有骨架不能因为新脚本没再写 descriptor 就被删掉；平级脚本会被拒绝。
 * 第一次出现 rig.joint 时写入参考尺寸。
 */
export function humanoidRigForAuthoredScript(
  source: string,
  incoming: unknown,
  previous: unknown
): { ok: true; rig: StoredHumanoidRig | null } | { ok: false; code: "rig-removed" | "invalid-rig"; message: string } {
  const next = readStoredRig(incoming);
  if (!next.ok) return { ok: false, code: "invalid-rig", message: next.message };
  const prior = readStoredRig(previous);
  if (!prior.ok) return { ok: false, code: "invalid-rig", message: prior.message };
  if (prior.value && next.value == null && !scriptUsesHumanoidRig(source)) {
    return { ok: false, code: "rig-removed", message: "不能移除已有骨架" };
  }
  if (next.value) return { ok: true, rig: next.value };
  if (prior.value) return { ok: true, rig: prior.value };
  if (!scriptUsesHumanoidRig(source)) return { ok: true, rig: null };
  const created = referenceHumanoidRig();
  if (!created.ok) return { ok: false, code: "invalid-rig", message: "参考骨架无法生成" };
  return { ok: true, rig: created.value };
}

function readStoredRig(value: unknown): { ok: true; value: StoredHumanoidRig | null } | { ok: false; message: string } {
  if (value == null) return { ok: true, value: null };
  const stored = storedHumanoidRig(value);
  if (!stored.ok) {
    const first = stored.diagnostics[0];
    return { ok: false, message: first ? `${first.path}: ${first.actual}` : "骨架非法" };
  }
  return { ok: true, value: stored.value };
}

/** 给模型和动作提示词用的关节用法。不包含可执行示例，避免和旧的人物示例抢同一条脚本。 */
export function humanoidAuthoringText(): string {
  return [
    "When the model is a humanoid or mecha, a fixed 14-joint rig already exists.",
    "Parent every visible shape with rig.joint(id). Legal joint ids:",
    HUMANOID_V1_JOINT_IDS.join(", ") + ".",
    "position and segment from/to are local to that joint origin, not standing-height coordinates of the whole body.",
    "The abdomen must span the spine bone. Parent a segment to Spine from [0, -0.5, 0] to [0, 0, 0]. A box on Hips plus a box on Spine leaves the waist empty.",
    "A left thigh runs from [0, 0, 0] to [0, -0.4, 0] under LeftUpperLeg. Do not parent a head at y=1.69 or a foot at y=0.06 to a joint.",
    "rig.joint(\"Root\") is not a shape parent. Hands and guns use rig.joint(\"LeftHand\") or rig.joint(\"RightHand\"); those are forearm sockets, not joints.",
    "Do not invent limb ids such as thigh, shin, Shoulder, Chest, Neck, or Hand, and do not parent limbs to Root.",
    "Motion targetId must be one of the joint ids. An in-place run needs distinct rotation tracks on both UpperLeg, LowerLeg, and Foot.",
    "A successful tool result is not evidence that the run used the joints."
  ].join(" ");
}
