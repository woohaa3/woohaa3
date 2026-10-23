import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PRESET_STORE_VERSION,
  NEW_DOCUMENT_LIMITS,
  SIZE_PRESETS,
  addDocumentPreset,
  canReopenRecent,
  canReplayDocumentSpec,
  createLocalDocumentPresetStorage,
  decodeDocumentPresetStore,
  emptyDocumentPresetStore,
  encodeDocumentPresetStore,
  parseDocumentPresetStore,
  planCloseAll,
  planCloseOthers,
  recordRecentDocument,
  removeDocumentPreset,
  requestDocumentSlot,
  runClosePlan,
  validateNewDocumentSpec
} from "./index.js";

const spec = (patch: Record<string, unknown> = {}) => ({
  width: 640,
  height: 480,
  resolution: 72,
  mode: "rgb",
  depth: 8,
  background: "white",
  name: "未命名",
  ...patch
});

describe("U01 新建文档尺寸与参数的输入拒绝边界", () => {
  it("接受内核同样接受的一组参数并规范化名称与默认值", () => {
    const result = validateNewDocumentSpec({ width: 640, height: 480, name: "  海报  " });
    expect(result).toEqual({
      ok: true,
      value: { width: 640, height: 480, resolution: 72, mode: "rgb", depth: 8, background: "white", name: "海报" }
    });
    expect(validateNewDocumentSpec({ width: 8, height: 8, name: "   " })).toMatchObject({ ok: true, value: { name: "未命名" } });
  });

  it("拒绝非整数、越界与超像素总量", () => {
    expect(validateNewDocumentSpec({ width: 0, height: 10 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10.5, height: 10 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: NEW_DOCUMENT_LIMITS.maxSide + 1, height: 10 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 8192, height: 8193 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10, height: 10, resolution: 0 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10, height: 10, resolution: 30_001 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10, height: 10, mode: "cmyk" })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10, height: 10, depth: 16 })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10, height: 10, background: "mauve" })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec({ width: 10, height: 10, name: "名".repeat(256) })).toMatchObject({ ok: false });
    expect(validateNewDocumentSpec("640×480")).toMatchObject({ ok: false });
  });

  it("接受十六进制背景并且只声明本运行时支持的模式", () => {
    expect(validateNewDocumentSpec({ width: 10, height: 10, background: "#3366cc" })).toMatchObject({ ok: true });
    expect(validateNewDocumentSpec({ width: 10, height: 10, background: "#3c6" })).toMatchObject({ ok: true });
    expect(canReplayDocumentSpec(spec())).toBe(true);
    expect(canReplayDocumentSpec(spec({ width: 0 }))).toBe(false);
  });

  it("尺寸预设都在共享上限之内，且 id/label 唯一", () => {
    expect(new Set(SIZE_PRESETS.map((preset) => preset.id)).size).toBe(SIZE_PRESETS.length);
    expect(new Set(SIZE_PRESETS.map((preset) => preset.label)).size).toBe(SIZE_PRESETS.length);
    for (const preset of SIZE_PRESETS) {
      expect(validateNewDocumentSpec({ width: preset.width, height: preset.height }), preset.id).toMatchObject({ ok: true });
    }
  });

  it("打印预设自带 DPI，屏幕预设不写 DPI", () => {
    const a4 = SIZE_PRESETS.find((preset) => preset.id === "a4-300");
    expect(a4, "A4 预设必须存在").toBeDefined();
    // 标签写着 300ppi，就必须真的带着 300：否则用户得到 72ppi 的同尺寸文档。
    expect(a4?.resolution).toBe(300);
    expect(a4?.label).toContain("300ppi");
    expect(validateNewDocumentSpec({ width: a4!.width, height: a4!.height, resolution: a4!.resolution })).toMatchObject({
      ok: true,
      value: { resolution: 300 }
    });
    for (const preset of SIZE_PRESETS.filter((entry) => entry.id !== "a4-300")) {
      expect(preset.resolution, `${preset.id} 不应把显示偏好写进文档`).toBeUndefined();
    }
  });
});

describe("U04 新建预设与最近设置的版本化存储", () => {
  it("逐条丢弃坏条目，保留其余预设与最近项", () => {
    const decoded = decodeDocumentPresetStore({
      version: DOCUMENT_PRESET_STORE_VERSION,
      presets: [
        { name: "  方形  ", settings: spec({ width: 1080, height: 1080 }) },
        { name: "方形", settings: spec({ width: 10, height: 10 }) },
        { name: "坏尺寸", settings: spec({ width: 0, height: 10 }) },
        { name: "   ", settings: spec() },
        null,
        "x"
      ],
      recent: [spec({ width: 64, height: 32 }), spec({ width: 64, height: 32 }), spec({ width: 0, height: 1 })]
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.presets.map((preset) => preset.name)).toEqual(["方形"]);
    expect(decoded.value.presets[0]?.settings.width).toBe(1080);
    expect(decoded.value.recent).toHaveLength(1);
  });

  it("不认识的版本或损坏 JSON 明确失败，不冒充空存储", () => {
    expect(decodeDocumentPresetStore({ version: 99, presets: [] })).toMatchObject({ ok: false });
    expect(decodeDocumentPresetStore({ presets: [] })).toMatchObject({ ok: false });
    expect(decodeDocumentPresetStore([])).toMatchObject({ ok: false });
    expect(parseDocumentPresetStore("{not json")).toMatchObject({ ok: false });
    expect(parseDocumentPresetStore("null")).toMatchObject({ ok: false });
  });

  it("保存/删除预设保持名称唯一且不修改入参", () => {
    const empty = emptyDocumentPresetStore();
    const added = addDocumentPreset(empty, "  方形海报  ", spec({ width: 1080, height: 1080 }));
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.presets[0]?.name).toBe("方形海报");
    expect(empty.presets).toHaveLength(0);

    expect(addDocumentPreset(added.value, "方形海报", spec())).toMatchObject({ ok: false });
    expect(addDocumentPreset(added.value, "方形海报", spec()).ok === false && (addDocumentPreset(added.value, "方形海报", spec()) as { error: string }).error).toContain("已存在");
    expect(addDocumentPreset(added.value, "   ", spec())).toMatchObject({ ok: false });
    expect(addDocumentPreset(added.value, "无效设置", spec({ width: 0 }))).toMatchObject({ ok: false });

    const removed = removeDocumentPreset(added.value, "方形海报");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.presets).toHaveLength(0);
    expect(removeDocumentPreset(added.value, "不存在")).toMatchObject({ ok: false });
    expect(removeDocumentPreset(added.value, " ")).toMatchObject({ ok: false });
  });

  it("最近设置最新在前、去重且有界，非法输入不改变列表", () => {
    let store = emptyDocumentPresetStore();
    store = recordRecentDocument(store, spec({ width: 8, height: 8 }));
    store = recordRecentDocument(store, spec({ width: 8, height: 8 }));
    expect(store.recent).toHaveLength(1);
    store = recordRecentDocument(store, spec({ width: 64, height: 32 }));
    expect(store.recent.map((entry) => entry.width)).toEqual([64, 8]);
    expect(recordRecentDocument(store, spec({ width: 0, height: 0 }))).toBe(store);

    for (let width = 100; width < 140; width += 1) store = recordRecentDocument(store, spec({ width, height: 10 }));
    expect(store.recent).toHaveLength(NEW_DOCUMENT_LIMITS.maxRecent);
    expect(store.recent[0]?.width).toBe(139);
    expect(canReopenRecent(store.recent[0]!)).toBe(true);
  });

  it("编码后可原样解码，并且只写版本化信封", () => {
    const store = recordRecentDocument(addDocumentPreset(emptyDocumentPresetStore(), "A", spec()).ok
      ? (addDocumentPreset(emptyDocumentPresetStore(), "A", spec()) as { value: ReturnType<typeof emptyDocumentPresetStore> }).value
      : emptyDocumentPresetStore(), spec({ width: 32, height: 16 }));
    const text = encodeDocumentPresetStore(store);
    expect(JSON.parse(text)).toMatchObject({ version: DOCUMENT_PRESET_STORE_VERSION });
    const decoded = parseDocumentPresetStore(text);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(store);
  });

  it("本机存储适配读写同一条版本化文本，不可用时明确失败", async () => {
    const map = new Map<string, string>();
    const fake = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); }
    };
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    try {
      const storage = createLocalDocumentPresetStorage("test.key");
      expect(await storage.load()).toBeNull();
      expect(await storage.save("{\"version\":1}")).toBe("saved");
      expect(await storage.load()).toBe("{\"version\":1}");
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }

    // 配额/隐私模式：明确返回 failed，调用方据此提示「仅本次会话」。
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); }
    };
    try {
      expect(await createLocalDocumentPresetStorage().save("x")).toBe("failed");
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }

    // 环境完全没有 localStorage：读写都安全降级，不抛异常。
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    try {
      expect(await createLocalDocumentPresetStorage().load()).toBeNull();
      expect(await createLocalDocumentPresetStorage().save("x")).toBe("failed");
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });
});

describe("U03 批量关闭的串行结算计划", () => {
  const targets = [
    { id: "a", dirty: false, gate: null },
    { id: "b", dirty: true, gate: null },
    { id: "c", dirty: false, gate: "正在绘制" }
  ];

  it("关闭其他只保留活动项，并列出未保存条目", () => {
    const plan = planCloseOthers(targets, "a");
    expect(plan).toEqual({ ok: true, order: ["b", "c"], unsaved: ["b"] });
    expect(planCloseOthers(targets, "missing")).toMatchObject({ ok: false, code: "invalid" });
    expect(planCloseOthers([], "a")).toMatchObject({ ok: false, code: "empty" });
    expect(planCloseOthers([{ id: "a", dirty: false, gate: null }], "a")).toMatchObject({ ok: false, code: "empty" });
    expect(planCloseOthers([...targets, targets[0]!], "a")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("关闭全部把活动项放在最后，未知活动项拒绝", () => {
    expect(planCloseAll(targets, "b")).toEqual({ ok: true, order: ["a", "c", "b"], unsaved: ["b"] });
    expect(planCloseAll(targets, null)).toMatchObject({ ok: true, order: ["a", "b", "c"] });
    expect(planCloseAll(targets, "z")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("首个失败处停止并保留后续文档", async () => {
    const plan = planCloseOthers(targets, "a");
    if (!plan.ok) throw new Error("plan");
    const attempted: string[] = [];
    const outcome = await runClosePlan(plan.order, async (id) => {
      attempted.push(id);
      return id === "c" ? { ok: false as const, reason: "请先结束当前笔迹" } : { ok: true as const };
    });
    expect(attempted).toEqual(["b", "c"]);
    expect(outcome.closed).toEqual(["b"]);
    expect(outcome.failed).toEqual({ id: "c", ok: false, reason: "请先结束当前笔迹" });
    expect(outcome.remaining).toEqual([]);
    expect(outcome.complete).toBe(false);
  });

  it("全部成功才报告完成；达到调用方给的上限就拒绝", async () => {
    const outcome = await runClosePlan(["a", "b"], async () => ({ ok: true as const }));
    expect(outcome.complete).toBe(true);
    expect(outcome.failed).toBeNull();
    // 上限由调用方传入（真源是共享工作区的 MAX_OPEN_DOCUMENTS），本域不复制常量。
    expect(requestDocumentSlot(7, 8)).toEqual({ ok: true });
    expect(requestDocumentSlot(8, 8)).toMatchObject({ ok: false });
    expect(requestDocumentSlot(8, 8) as { reason: string }).toMatchObject({ reason: expect.stringContaining("8") });
    expect(requestDocumentSlot(-1, 8)).toMatchObject({ ok: false });
    // 上限本身非法时也要拒绝，而不是把「0 个上限」当成永远可申请。
    expect(requestDocumentSlot(0, 0)).toMatchObject({ ok: false });
  });
});
