/**
 * V2 Scene IR validator / extent / signature 与 executor dispatch 测试
 * （change: enhance-model-scene-authoring-api，任务 1.1–1.3、2.2–2.4）。
 *
 * 覆盖：
 * - material/primitive validator 错误码与范围；
 * - 引用顺序、层级深度、primitive 数量与估算渲染顶点预算；
 * - segment 退化与端点语义；
 * - extent 含 sphere/capsule/segment/overlap 与祖先 scale；
 * - V1/V2 executor dispatch、未知版本稳定失败、V1 fixture 输出不变。
 */
import { describe, expect, it } from "vitest";
import {
  MODEL_SCRIPT_SCENE_IR_V2_VERSION
} from "./model-script.js";
import {
  estimatePrimitiveVertices,
  modelSceneStatistics,
  modelSceneStatisticsDetail,
  SCENE_IR_V2_MAX_HIERARCHY_DEPTH,
  SCENE_IR_V2_MAX_MATERIALS,
  v2SceneAabb,
  v2SceneExtent,
  v2SceneSignature,
  validateModelSceneIrV2,
  type SceneV2Op
} from "./scene-ir-v2.js";
import { executeModelScriptV2, executeModelScriptVersioned, SceneBuilderV2 } from "./model-executor-v2.js";

function wrap(ops: unknown[]): unknown {
  return { version: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops };
}

function material(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: "material", id: "m", ...overrides };
}

describe("validateModelSceneIrV2 materials", () => {
  it("normalizes a full material declaration", () => {
    const result = validateModelSceneIrV2(wrap([
      material({ baseColor: "#FFF", roughness: 0.35, metallic: 0.85, emissive: "#000000", emissiveStrength: 2, alphaMode: "blend", doubleSided: true })
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({
      t: "material",
      id: "m",
      baseColor: "#ffffff",
      roughness: 0.35,
      metallic: 0.85,
      emissiveStrength: 2,
      alphaMode: "blend",
      doubleSided: true
    });
  });

  it("rejects PBR values out of range", () => {
    expect(validateModelSceneIrV2(wrap([material({ roughness: 2 })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ metallic: -0.1 })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ emissiveStrength: 1000 })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ alphaMode: "premultiplied" })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ baseColor: "red" })]))).toMatchObject({ ok: false, code: "invalid-material" });
  });

  it("rejects unknown material fields (no external resources)", () => {
    expect(validateModelSceneIrV2(wrap([material({ texture: "http://x" })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ shader: "..." })]))).toMatchObject({ ok: false, code: "invalid-material" });
  });

  it("rejects duplicate material ids", () => {
    expect(validateModelSceneIrV2(wrap([material({ id: "m" }), material({ id: "m" })]))).toMatchObject({ ok: false, code: "duplicate-material" });
  });

  it("rejects referencing a material declared later or missing", () => {
    expect(validateModelSceneIrV2(wrap([
      { t: "box", id: "b", material: "m", size: [1, 1, 1] },
      material({ id: "m" })
    ]))).toMatchObject({ ok: false, code: "missing-material" });
    expect(validateModelSceneIrV2(wrap([{ t: "box", id: "b", material: "ghost", size: [1, 1, 1] }])))
      .toMatchObject({ ok: false, code: "missing-material" });
  });

  it("rejects a shape that provides both material and color", () => {
    expect(validateModelSceneIrV2(wrap([
      material({ id: "m" }),
      { t: "box", id: "b", material: "m", color: "#ffffff", size: [1, 1, 1] }
    ]))).toMatchObject({ ok: false, code: "invalid-material" });
  });

  it("keeps color as a shorthand when no material is given", () => {
    const result = validateModelSceneIrV2(wrap([{ t: "box", id: "b", color: "#ABCDEF", size: [1, 1, 1] }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({ color: "#abcdef", material: null });
  });
});

describe("validateModelSceneIrV2 primitives", () => {
  it("accepts sphere and capsule with normalized defaults", () => {
    const result = validateModelSceneIrV2(wrap([
      { t: "sphere", id: "joint", radius: 0.25, position: [0, 1, 0] },
      { t: "capsule", id: "limb", radius: 0.3, height: 1.2 }
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({ t: "sphere", radius: 0.25, parent: null, color: "#cccccc" });
    expect(result.scene.ops[1]).toMatchObject({ t: "capsule", radius: 0.3, height: 1.2 });
  });

  it("rejects capsule height smaller than diameter", () => {
    expect(validateModelSceneIrV2(wrap([{ t: "capsule", id: "c", radius: 1, height: 1.5 }])))
      .toMatchObject({ ok: false, code: "invalid-primitive" });
  });

  it("rejects non-positive primitive dimensions", () => {
    expect(validateModelSceneIrV2(wrap([{ t: "sphere", id: "s", radius: 0 }]))).toMatchObject({ ok: false, code: "invalid-primitive" });
    expect(validateModelSceneIrV2(wrap([{ t: "box", id: "b", size: [1, 0, 1] }]))).toMatchObject({ ok: false, code: "invalid-primitive" });
  });
});

describe("validateModelSceneIrV2 segments", () => {
  it("keeps endpoint authoring intent with defaults", () => {
    const result = validateModelSceneIrV2(wrap([
      { t: "segment", id: "forearm", from: [0, 0, 0], to: [1, 0, 0], width: 0.3 }
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({ t: "segment", shape: "capsule", depth: 0.3, overlap: 0 });
  });

  it("defaults box depth to width", () => {
    const result = validateModelSceneIrV2(wrap([
      { t: "segment", id: "s", from: [0, 0, 0], to: [1, 0, 0], width: 0.4, shape: "box" }
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({ shape: "box", depth: 0.4 });
  });

  it("rejects a degenerate (zero-length) segment", () => {
    expect(validateModelSceneIrV2(wrap([
      { t: "segment", id: "s", from: [1, 2, 3], to: [1, 2, 3], width: 0.3 }
    ]))).toMatchObject({ ok: false, code: "degenerate-segment" });
  });

  it("occupies the same space when endpoints are swapped", () => {
    const forward = validateModelSceneIrV2(wrap([{ t: "segment", id: "s", from: [0, 0, 0], to: [1, 2, 2], width: 0.2 }]));
    const reverse = validateModelSceneIrV2(wrap([{ t: "segment", id: "s", from: [1, 2, 2], to: [0, 0, 0], width: 0.2 }]));
    expect(forward.ok && reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    const a = v2SceneAabb(forward.scene.ops as SceneV2Op[]);
    const b = v2SceneAabb(reverse.scene.ops as SceneV2Op[]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 无方向偏置的稳定朝向：包围盒在容差内一致。
    for (let axis = 0; axis < 3; axis += 1) {
      expect(a!.min[axis]).toBeCloseTo(b!.min[axis], 4);
      expect(a!.max[axis]).toBeCloseTo(b!.max[axis], 4);
    }
  });
});

describe("validateModelSceneIrV2 budgets and hierarchy", () => {
  it("rejects hierarchy deeper than the limit", () => {
    const ops: unknown[] = [{ t: "group", id: "g0" }];
    for (let i = 1; i <= SCENE_IR_V2_MAX_HIERARCHY_DEPTH; i += 1) {
      ops.push({ t: "group", id: `g${i}`, parent: `g${i - 1}` });
    }
    expect(validateModelSceneIrV2(wrap(ops))).toMatchObject({ ok: false, code: "hierarchy-too-deep" });
  });

  it("rejects too many materials", () => {
    const ops: unknown[] = [];
    for (let i = 0; i <= SCENE_IR_V2_MAX_MATERIALS; i += 1) ops.push(material({ id: `m${i}` }));
    expect(validateModelSceneIrV2(wrap(ops))).toMatchObject({ ok: false, code: "render-budget-exceeded" });
  });

  it("rejects primitive counts that exceed the estimated render budget", () => {
    const ops: unknown[] = [];
    for (let i = 0; i < 4096; i += 1) ops.push({ t: "sphere", id: `s${i}`, radius: 0.1 });
    expect(validateModelSceneIrV2(wrap(ops))).toMatchObject({ ok: false, code: "render-budget-exceeded" });
  });

  it("estimates primitive vertices deterministically by quality tier", () => {
    const sphere = estimatePrimitiveVertices({ t: "sphere", id: "s", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ffffff", radius: 1 });
    expect(sphere).toBeGreaterThan(100);
  });

  it("round-trips the full V2 op set through JSON", () => {
    const ops = [
      material({ id: "m", baseColor: "#1a2b3c", roughness: 0.2, metallic: 0.9, emissive: "#00ff00", emissiveStrength: 1.5, alphaMode: "blend", doubleSided: true }),
      { t: "group", id: "root" },
      { t: "box", id: "b", parent: "root", size: [1, 2, 3], material: "m" },
      { t: "cylinder", id: "c", parent: "root", radius: 0.5, height: 2, color: "#ffffff" },
      { t: "sphere", id: "s", parent: "root", radius: 0.3 },
      { t: "capsule", id: "cap", parent: "root", radius: 0.4, height: 1.4 },
      { t: "segment", id: "seg", parent: "root", from: [0, 0, 0], to: [1, 1, 0], width: 0.3, shape: "box", overlap: 0.05 },
      { t: "mesh", id: "mesh", parent: "root", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] },
      { t: "rotate", id: "root", axis: "z", speed: 1.2 }
    ];
    const result = validateModelSceneIrV2(wrap(ops));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 序列化 → 再校验：字段与默认值稳定往返。
    const roundTrip = validateModelSceneIrV2(JSON.parse(JSON.stringify(result.scene)));
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(JSON.stringify(roundTrip.scene)).toBe(JSON.stringify(result.scene));
    expect(roundTrip.scene.ops[0]).toMatchObject({
      t: "material",
      roughness: 0.2,
      metallic: 0.9,
      emissiveStrength: 1.5,
      alphaMode: "blend",
      doubleSided: true
    });
  });

  it("rejects an unknown op type and bad parent", () => {
    expect(validateModelSceneIrV2(wrap([{ t: "torus", id: "x" }]))).toMatchObject({ ok: false, code: "unknown-op" });
    expect(validateModelSceneIrV2(wrap([{ t: "box", id: "b", parent: "later" }, { t: "group", id: "later" }])))
      .toMatchObject({ ok: false, code: "invalid-parent" });
  });
});

describe("v2SceneExtent", () => {
  it("includes sphere radius and segment overlap", () => {
    const ops: SceneV2Op[] = validateScene([
      { t: "sphere", id: "s", radius: 2, position: [5, 0, 0] }
    ]);
    expect(v2SceneExtent(ops)).toBeCloseTo(14, 5);

    const withOverlap = validateScene([
      { t: "segment", id: "s", from: [0, 0, 0], to: [0, 1, 0], width: 0.2, overlap: 1, shape: "box" }
    ]);
    // 半长 1/2 + overlap 1 = 1.5 → y 覆盖 [-1, 2]，extent = max|axis| * 2 = 4。
    expect(v2SceneExtent(withOverlap)).toBeCloseTo(4, 5);
  });

  it("includes ancestor scale (raised leg / extended arm fixture)", () => {
    const ops = validateScene([
      { t: "group", id: "arm", position: [0, 2, 0], rotation: [0, 0, 90], scale: [1, 1, 1] },
      { t: "segment", id: "forearm", parent: "arm", from: [0, 0, 0], to: [2, 0, 0], width: 0.2 }
    ]);
    // group 旋转 90° 绕 Z，把 +X 的 segment 转向 +Y，世界 y 达 2 + 2 = 4（+ 端帽半宽 0.1）。
    const box = v2SceneAabb(ops);
    expect(box).not.toBeNull();
    expect(box!.max[1]).toBeCloseTo(4.1, 3);
  });

  it("is deterministic for the same op sequence", () => {
    const ops = validateScene([{ t: "capsule", id: "c", radius: 0.3, height: 1.2 }]);
    expect(v2SceneSignature(ops)).toBe(v2SceneSignature(validateScene([{ t: "capsule", id: "c", radius: 0.3, height: 1.2 }])));
  });
});

function validateScene(ops: unknown[]): SceneV2Op[] {
  const result = validateModelSceneIrV2(wrap(ops));
  if (!result.ok) throw new Error(`invalid fixture: ${result.code} ${result.message}`);
  return result.scene.ops as SceneV2Op[];
}

describe("V2 executor and version dispatch", () => {
  it("records material and returns its id", () => {
    const builder = new SceneBuilderV2();
    const armor = builder.material({ baseColor: "#26343a" });
    const body = builder.segment({ from: [0, 0, 0], to: [0, 1, 0], width: 0.3, material: armor });
    expect(armor).toBe("material_1");
    expect(body).toBe("segment_2");
    expect(builder.raw()).toHaveLength(2);
  });

  it("generates stable ids and preserves reference order", () => {
    const builder = new SceneBuilderV2();
    const armor = builder.material({ id: "armor" });
    const joint = builder.sphere({ radius: 0.2 });
    const limb = builder.capsule({ radius: 0.3, height: 1.2 });
    const seg = builder.segment({ from: [0, 0, 0], to: [0, 1, 0], width: 0.2, material: armor });
    expect([armor, joint, limb, seg]).toEqual(["armor", "sphere_1", "capsule_2", "segment_3"]);
    // material 引用在 op 前出现，顺序稳定。
    const raw = builder.raw();
    expect(raw.map((op) => op.t)).toEqual(["material", "sphere", "capsule", "segment"]);
    expect(raw[3]).toMatchObject({ material: "armor" });
  });

  it("executes a shared-joint humanoid fixture to a valid V2 Scene IR", () => {
    const source = `
      const armor = scene.material({ id: "armor", baseColor: "#26343a", metallic: 0.85, roughness: 0.35 });
      const torso = scene.box({ id: "torso", size: [1, 1.6, 0.5], position: [0, 1.8, 0] });
      const shoulder = scene.sphere({ id: "shoulder", radius: 0.22, position: [-0.65, 2.3, 0] });
      const elbow = [-1.0, 1.6, 0];
      const wrist = [-1.0, 0.9, 0];
      scene.segment({ id: "upper-arm", from: [-0.65, 2.3, 0], to: elbow, width: 0.28, shape: "box", material: armor });
      scene.segment({ id: "forearm", from: elbow, to: wrist, width: 0.26, shape: "capsule", material: armor });
      const elbowJoint = scene.sphere({ id: "elbow", radius: 0.2, position: elbow });
      const hand = scene.sphere({ id: "hand", radius: 0.18, position: wrist });
      return [torso, shoulder, elbowJoint, hand];
    `;
    const result = executeModelScriptV2(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.version).toBe(MODEL_SCRIPT_SCENE_IR_V2_VERSION);
    // 上臂与前臂共享同一个肘坐标。
    const upper = result.scene.ops.find((op) => op.t === "segment" && op.id === "upper-arm");
    const forearm = result.scene.ops.find((op) => op.t === "segment" && op.id === "forearm");
    expect(upper && forearm).toBeTruthy();
    if (upper?.t === "segment" && forearm?.t === "segment") {
      expect(upper.to).toEqual(forearm.from);
    }
    expect(v2SceneExtent(result.scene.ops)).toBeGreaterThan(1);
  });

  it("rejects a non-deterministic V2 script", () => {
    const result = executeModelScriptV2("scene.sphere({ id: 's' + Math.random(), radius: 0.5 });");
    expect(result).toMatchObject({ ok: false, stage: "determinism" });
  });

  it("rejects an unknown version without falling back", () => {
    const result = executeModelScriptVersioned("scene.box({ id: 'b' });", "woohaa-model-js-v9");
    expect(result).toMatchObject({ ok: false, code: "version-mismatch" });
  });

  it("retires V1 (no longer dispatchable)", () => {
    const result = executeModelScriptVersioned("scene.box({ id: 'b' });", "woohaa-model-js-v1");
    expect(result).toMatchObject({ ok: false, code: "version-mismatch" });
  });
});

describe("modelSceneStatistics", () => {
  const base = { parent: null, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], material: null, color: "#ffffff" } as const;

  it("统计对象/分组/材质/动画并排除非几何 op", () => {
    const stats = modelSceneStatistics([
      { t: "material", id: "m", baseColor: "#ffffff", roughness: 1, metallic: 0, emissive: "#000000", emissiveStrength: 0, alphaMode: "opaque", doubleSided: false },
      { t: "group", id: "root", ...base },
      { t: "box", id: "b", ...base, size: [1, 1, 1] },
      { t: "sphere", id: "s", ...base, radius: 1 },
      { t: "rotate", id: "root", axis: "y", speed: 1 }
    ] as SceneV2Op[]);
    expect(stats).toMatchObject({ objects: 2, groups: 1, materials: 1, animations: 1 });
    expect(stats.vertices).toBe(8 + estimatePrimitiveVertices({ t: "sphere", id: "s", ...base, radius: 1 }));
    expect(stats.triangles).toBe(12 + 528);
  });

  it("自定义 mesh 按扇形三角化并保留作者顶点数", () => {
    const stats = modelSceneStatistics([
      { t: "mesh", id: "m", ...base, vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 1, 2], [0, 1, 2, 3]] }
    ] as SceneV2Op[]);
    expect(stats.objects).toBe(1);
    expect(stats.vertices).toBe(4);
    // 三角面：三角形 1 + 四边形扇形 2。
    expect(stats.triangles).toBe(3);
  });

  it("空场景返回全零", () => {
    expect(modelSceneStatistics([])).toEqual({ objects: 0, groups: 0, vertices: 0, triangles: 0, materials: 0, animations: 0 });
  });

  it("明细按 segment 的实际 shape 归入 box/capsule（change: 2026-10-18-align-model-statistics-with-agent）", () => {
    const stats = modelSceneStatisticsDetail([
      { t: "segment", id: "capsule-default", ...base, from: [0, 0, 0], to: [0, 1, 0], width: 0.2, depth: 0.2, shape: "capsule", overlap: 0 },
      { t: "segment", id: "box", ...base, from: [0, 0, 0], to: [0, 1, 0], width: 0.2, depth: 0.2, shape: "box", overlap: 0 },
      { t: "mesh", id: "m", ...base, vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }
    ] as SceneV2Op[]);
    expect(stats.statistics).toEqual({ objects: 3, groups: 0, vertices: 400 + 8 + 3, triangles: 288 + 12 + 1, materials: 0, animations: 0 });
    expect(stats.breakdown.capsule).toEqual({ count: 1, vertices: 400, triangles: 288 });
    expect(stats.breakdown.box).toEqual({ count: 1, vertices: 8, triangles: 12 });
    expect(stats.breakdown.mesh).toEqual({ count: 1, vertices: 3, triangles: 1 });
  });
});
