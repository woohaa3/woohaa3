/**
 * 笔刷工作流界面状态的回归（change: 2026-10-22-complete-photocraft-webui-editing，任务 2.1–2.5）。
 *
 * 只测纯函数与控制器：内核画笔像素在 Rust 侧测试；这里锁定「参数编译成正确的命令补丁」
 * 与「失败不覆盖有效库」两个契约。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DYNAMICS,
  BrushLibraryController,
  decodeAbrReport,
  decodeBrushPresetList,
  dynamicsFromBrush,
  dynamicsPatch
} from "../../brush-library-state.js";
import { DEFAULT_BRUSH, buildStroke, type BrushSettings } from "../../photo-editor-tools.js";
import { mergeBrushPatch } from "../../paint-tool-state.js";
import type { EditorHandle } from "../../editor-wasm.js";

describe("笔尖与动态参数（任务 2.1/2.2/3.3）", () => {
  it("动态补丁与内核 BrushSettings 字段同名，关闭时保留用户值", () => {
    const patch = dynamicsPatch({
      ...DEFAULT_DYNAMICS,
      sizeControl: "off",
      sizeJitter: 0,
      sizeMinimum: 0.4,
      spacing: 0.5,
      roundness: 0.6,
      angle: 33,
      flipX: true,
      scatter: 1.25,
      scatterCount: 4
    }) as Record<string, Record<string, unknown>>;
    expect(patch.spacing).toBe(0.5);
    expect(patch.roundness).toBe(0.6);
    expect(patch.angle).toBe(33);
    expect(patch.flipX).toBe(true);
    expect((patch.shapeDynamics as Record<string, unknown>).enabled).toBe(false);
    // 最小值保留，即使控制已关（Photoshop 语义）。
    expect((patch.shapeDynamics as Record<string, Record<string, unknown>>).size.minimum).toBe(0.4);
    expect((patch.scattering as Record<string, Record<string, unknown>>).scatter.jitter).toBe(1.25);
    expect((patch.scattering as Record<string, unknown>).count).toBe(4);
  });

  it("参数越界被钳制在公开范围内", () => {
    const patch = dynamicsPatch({
      ...DEFAULT_DYNAMICS,
      spacing: 99,
      roundness: -3,
      scatter: 40,
      scatterCount: 99,
      smoothing: 8,
      angle: 9999
    }) as Record<string, number | Record<string, unknown>>;
    expect(patch.spacing).toBe(10);
    expect(patch.roundness).toBe(0);
    expect(patch.angle).toBe(360);
    expect((patch.scattering as Record<string, unknown>).count).toBe(16);
    expect((patch.smoothing as Record<string, unknown>).amount).toBe(1);
  });

  it("从内核设置折回界面参数（缺字段用默认值，不伪造倾斜）", () => {
    const folded = dynamicsFromBrush({
      spacing: 0.3,
      roundness: 0.8,
      shapeDynamics: { enabled: true, size: { jitter: 0.2, control: "penTilt", minimum: 0.1 } },
      transfer: { enabled: true, opacity: { control: "penPressure" } },
      scattering: { enabled: true, scatter: { jitter: 0.5 }, count: 3 },
      smoothing: { amount: 0.4, pulledString: true, catchUp: false, catchUpOnEnd: true, adjustForZoom: false }
    });
    expect(folded.spacing).toBe(0.3);
    expect(folded.roundness).toBe(0.8);
    expect(folded.sizeControl).toBe("penTilt");
    expect(folded.sizeMinimum).toBe(0.1);
    expect(folded.opacityControl).toBe("penPressure");
    expect(folded.scatter).toBe(0.5);
    expect(folded.scatterCount).toBe(3);
    expect(folded.smoothing).toBe(0.4);
    expect(folded.pulledString).toBe(true);
    expect(folded.catchUp).toBe(false);
    expect(folded.adjustForZoom).toBe(false);
    // 缺失数据的字段取明确默认值，而不是猜测。
    expect(dynamicsFromBrush(null)).toEqual(DEFAULT_DYNAMICS);
    expect(dynamicsFromBrush({ shapeDynamics: { size: { control: "unknown" } } }).sizeControl).toBe("off");
  });
});

describe("笔迹命令编译（任务 2.1/2.2）", () => {
  it("动态补丁作为 paint.stroke 的 brush 参数透传", () => {
    const brush: BrushSettings = {
      ...DEFAULT_BRUSH,
      dynamics: { spacing: 0.4, shapeDynamics: { enabled: true, size: { jitter: 0.3 } } }
    };
    const params = buildStroke([{ x: 1, y: 2, pressure: 0.5 }], brush)!;
    expect(params.points).toEqual([[1, 2, 0.5]]);
    expect(params.brush).toEqual({ spacing: 0.4, shapeDynamics: { enabled: true, size: { jitter: 0.3 } } });
    // 没有动态时不发送空对象（保持首期参数形状）。
    const plain = buildStroke([{ x: 1, y: 2 }], { ...DEFAULT_BRUSH })!;
    expect(plain.brush).toBeUndefined();
  });

  it("工具参数补丁把标量与动态分开合并", () => {
    const current: BrushSettings = { ...DEFAULT_BRUSH, dynamics: { roundness: 0.5 } };
    const next = mergeBrushPatch(current, { size: 64, hardness: 0.2, roundness: 0.9, flipX: true });
    expect(next.size).toBe(64);
    expect(next.hardness).toBe(0.2);
    expect(next.dynamics).toEqual({ roundness: 0.9, flipX: true });
    // 标量改动不动动态，动态改动不动标量。
    const scaled = mergeBrushPatch(next, { size: 12 });
    expect(scaled.dynamics).toEqual({ roundness: 0.9, flipX: true });
    expect(scaled.hardness).toBe(0.2);
  });
});

describe("库响应解码（任务 2.4/2.5）", () => {
  it("接受有界预设列表并保留分组", () => {
    const list = decodeBrushPresetList({
      presets: [
        { name: "Hard Round", group: "round", folder: [], origin: "builtin", sampled: false },
        { name: "Sampled", group: "sampled", folder: ["子"], origin: "abr", sampled: true }
      ],
      count: 2,
      groups: [{ group: "round", count: 1 }]
    });
    expect(list?.presets).toHaveLength(2);
    expect(list?.groups).toEqual([{ group: "round", count: 1 }]);
    expect(list?.presets[1]?.folder).toEqual(["子"]);
  });

  it("拒绝重复名、非法来源与畸形结构", () => {
    const base = { name: "x", group: "g", folder: [], origin: "builtin", sampled: false };
    expect(decodeBrushPresetList({ presets: [base, base] })).toBeNull();
    expect(decodeBrushPresetList({ presets: [{ ...base, origin: "remote" }] })).toBeNull();
    expect(decodeBrushPresetList({ presets: [{ ...base, name: "" }] })).toBeNull();
    expect(decodeBrushPresetList({ presets: "nope" })).toBeNull();
    expect(decodeBrushPresetList(null)).toBeNull();
  });

  it("ABR 报告只接受有界字段", () => {
    const report = decodeAbrReport({
      group: "导入",
      supported: 3,
      unsupported: ["太大（超出笔尖上限）", 7],
      version: 6,
      warnings: ["legacy"]
    });
    expect(report).toEqual({ group: "导入", supported: 3, unsupported: ["太大（超出笔尖上限）"], version: 6, warnings: ["legacy"] });
    expect(decodeAbrReport({ supported: "3" })).toBeNull();
    expect(decodeAbrReport(null)).toBeNull();
  });
});

/** 最小内核替身：只实现笔刷库方法，其余调用直接失败（测试不触发它们）。 */
function stubHandle(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const state = {
    presets: [{ name: "Hard Round", group: "round", folder: [], origin: "builtin", sampled: false }],
    current: null as string | null,
    abr: { group: "导入", supported: 2, unsupported: [], version: 6, warnings: [] } as unknown
  };
  const fail = { ok: false as const, code: "unsupported", message: "未实现" };
  const handle = {
    brushPresets: (full: boolean) => {
      calls.push(`presets:${full}`);
      return { ok: true as const, value: { presets: state.presets, count: state.presets.length, groups: [] } };
    },
    selectBrushPreset: (name: string) => {
      calls.push(`select:${name}`);
      if (!state.presets.some((preset) => preset.name === name)) return fail;
      state.current = name;
      return { ok: true as const, value: { name } };
    },
    saveBrushPreset: (params: unknown) => {
      calls.push("save");
      const name = (params as { name: string }).name;
      state.presets = [...state.presets, { name, group: "general", folder: [], origin: "user", sampled: false }];
      return { ok: true as const, value: { name } };
    },
    renameBrushPreset: (name: string, newName: string) => {
      calls.push("rename");
      state.presets = state.presets.map((preset) => (preset.name === name ? { ...preset, name: newName } : preset));
      return { ok: true as const, value: { name: newName } };
    },
    deleteBrushPreset: (name: string) => {
      calls.push("delete");
      state.presets = state.presets.filter((preset) => preset.name !== name);
      return { ok: true as const, value: { name } };
    },
    moveBrushPreset: () => ({ ok: true as const, value: {} }),
    brushPreview: () => ({ ok: true as const, value: { width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) } }),
    brushLibrarySnapshot: () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }),
    restoreBrushLibrary: () => ({ ok: true as const, value: { count: 1 } }),
    inspectBrushAbr: () => ({ ok: true as const, value: state.abr }),
    commitBrushAbr: (params: unknown) => {
      calls.push(`commit:${(params as { onlySupported: boolean }).onlySupported}`);
      return { ok: true as const, value: { count: 2 } };
    },
    cancelBrushAbr: () => ({ ok: true as const, value: { cancelled: true } }),
    importBrushFromImage: () => ({ ok: true as const, value: { name: "图片笔尖" } }),
    ...overrides
  } as unknown as EditorHandle;
  return { handle, calls, state };
}

describe("库控制器（任务 2.5）", () => {
  it("选中预设推进当前名，失败保留原状态", () => {
    const { handle } = stubHandle();
    const controller = new BrushLibraryController(() => handle);
    controller.refresh();
    expect(controller.snapshot().list?.presets).toHaveLength(1);
    expect(controller.select("Hard Round")).toBe(true);
    expect(controller.snapshot().current).toBe("Hard Round");
    expect(controller.select("不存在")).toBe(false);
    expect(controller.snapshot().current).toBe("Hard Round");
    expect(controller.snapshot().message).toContain("未实现");
  });

  it("保存重名默认被拒绝；显式覆盖才发送", async () => {
    const { handle, calls } = stubHandle();
    const controller = new BrushLibraryController(() => handle);
    controller.refresh();
    expect(await controller.save({ name: "Hard Round" })).toBe(false);
    expect(calls).not.toContain("save");
    expect(await controller.save({ name: "Hard Round", overwrite: true })).toBe(true);
    expect(calls).toContain("save");
  });

  it("持久化失败保留内存库并明确提示未保存", async () => {
    const { handle } = stubHandle();
    let attempts = 0;
    const controller = new BrushLibraryController(() => handle, {
      load: async () => null,
      save: async () => {
        attempts += 1;
        return "failed";
      }
    });
    controller.refresh();
    expect(await controller.save({ name: "新预设" })).toBe(true);
    expect(attempts).toBe(1);
    // 成功保存到内核（内存库可用），但持久化失败必须如实呈现。
    expect(controller.snapshot().list?.presets.some((preset) => preset.name === "新预设")).toBe(true);
    expect(controller.snapshot().persistence).toBe("failed");
    expect(controller.snapshot().message).toContain("未写入");
  });

  it("宿主没有存储端口时标为未持久化而不是已保存", async () => {
    const { handle } = stubHandle();
    const controller = new BrushLibraryController(() => handle);
    controller.refresh();
    expect(await controller.save({ name: "仅会话" })).toBe(true);
    expect(controller.snapshot().persistence).toBe("unsaved");
  });

  it("ABR 预检不发布，确认后才提交", async () => {
    const { handle, calls } = stubHandle();
    const controller = new BrushLibraryController(() => handle);
    controller.refresh();
    const report = await controller.inspectAbr(new Uint8Array([1]), "导入");
    expect(report?.supported).toBe(2);
    expect(calls.some((call) => call.startsWith("commit:"))).toBe(false);
    expect(await controller.commitAbr(true)).toBe(true);
    expect(calls).toContain("commit:true");
    expect(controller.snapshot().report).toBeNull();
  });

  it("恢复失败保留默认库并给出原因", async () => {
    const { handle } = stubHandle({
      restoreBrushLibrary: () => ({ ok: false as const, code: "command-failed", message: "格式无效" })
    });
    const controller = new BrushLibraryController(() => handle, {
      load: async () => new Uint8Array([9, 9]),
      save: async () => "saved"
    });
    await controller.restore();
    expect(controller.snapshot().message).toContain("格式无效");
    expect(controller.snapshot().persistence).toBe("unknown");
  });
});
