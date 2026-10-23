/** @vitest-environment jsdom */
// 面板交互检查：只驱动指针/输入事件并观察命令参数，不创建渲染上下文或截图。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { decodeVectorShapeParams } from "@woohaa3/photocraft-protocol";
import { VectorToolsPanel } from "./vector-tools-panel.js";
import { requestShapeSize } from "./shape-options.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

type Command = { id: string; params: Record<string, unknown> };

function setup(options: {
  snapshot?: Record<string, unknown>;
  library?: Record<string, unknown>;
  layer?: number | null;
  hasSelection?: boolean;
  readonly?: boolean;
} = {}) {
  const commands: Command[] = [];
  const controller = {
    vectorSnapshot: () => ({ ok: true, value: options.snapshot ?? { shapes: [], vectorMasks: [], paths: [], workPath: null, clippingPath: null } }),
    features: { vectors: { vectorPresets: () => ({ ok: true, value: options.library ?? { groups: [], custom: [] } }) } },
    vectorCommand: (id: string, params: Record<string, unknown>) => { commands.push({ id, params }); return { ok: true, value: {} }; },
  } as unknown as EditorWorkspaceController;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <VectorToolsPanel
      controller={controller}
      readonly={options.readonly ?? false}
      layer={options.layer === undefined ? 3 : options.layer}
      color="#3366cc"
      hasSelection={options.hasSelection ?? true}
      revision={1}
      shapeLayers={2}
    />,
  ));
  const buttons = () => [...container.querySelectorAll("button")];
  const button = (label: string) => buttons().find(node => node.textContent === label)!;
  const inputs = () => [...container.querySelectorAll("input")];
  // React 的文本/数字输入监听 `input`，`<select>` 监听 `change`；两者都走受控更新。
  // 必须绕开实例上的 value 属性：React 用它做变更追踪，直接赋值会被判定为「没变化」而丢掉事件。
  const setValue = (node: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
  };
  const change = (node: HTMLInputElement | HTMLSelectElement, value: string, event = "change") => act(() => {
    setValue(node, value);
    node.dispatchEvent(new Event(event, { bubbles: true }));
  });
  const type = (node: HTMLInputElement, value: string) => change(node, value, "input");
  // 按 `<label>` 文本定位输入框：同一面板里有多个数值框（草稿/属性/蒙版），不能只看 value。
  const labelled = (text: string, inside: ParentNode = container) => {
    const label = [...inside.querySelectorAll("label")].find(node => node.textContent?.trim().startsWith(text));
    return (label?.querySelector("input,select") ?? null) as HTMLInputElement | HTMLSelectElement | null;
  };
  return { container, commands, button, buttons, inputs, change, type, labelled };
}

const shape = {
  layer: 3,
  name: "Rectangle 1",
  kind: "roundedRect",
  live: { kind: "rect", rect: [10, 20, 100, 60], radii: [8, 8, 8, 8] },
  hasFill: true,
  hasStroke: true,
  fill: { type: "solid", hex: "#3366cc" },
  stroke: { width: 3, opacity: 0.5, align: "inside", cap: "round", join: "bevel", dashes: [4, 2], dashOffset: 1, paint: { hex: "#000000" } },
};

describe("形状与路径面板（U08–U16）", () => {
  it("数值创建使用与拖绘同一份几何参数", () => {
    const { button, commands } = setup();
    act(() => button("创建形状").click());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.id).toBe("shape.create");
    expect(commands[0]!.params).toMatchObject({ kind: "rect", rect: [0, 0, 100, 100], fill: "#3366cc" });
    // 面板送出的参数同样要通过协议解码器：数值入口与拖绘入口只有一份 wire 契约。
    expect(decodeVectorShapeParams(commands[0]!.params)).not.toBeNull();
  });

  it("画布单击（零面积）把起点填进面板并聚焦宽度输入", () => {
    const { container } = setup();
    // 第一组 label 就是形状的 X/Y/宽/高（按文本首字符定位，避免依赖顺序）。
    const x = [...container.querySelectorAll("label")].filter(node => node.querySelector("input[type=number]"))
      .find(node => (node.firstChild?.textContent ?? "").trim() === "X")!.querySelector("input")!;
    const width = container.querySelector<HTMLInputElement>("[data-shape-width]")!;
    expect(width).not.toBeNull();
    act(() => requestShapeSize([120, 80]));
    // 起点换成点击位置（取整），宽度拿到焦点供直接键入。
    expect(Number(x.value)).toBe(120);
    expect(document.activeElement).toBe(width);
    expect(container.textContent).toContain("请输入宽高");
  });

  it("每种形状的数值创建参数都被协议接受（含 line 与 star 的专属字段）", () => {
    const { container, button, commands, change } = setup();
    const select = (): HTMLSelectElement => container.querySelector("select")!;
    for (const kind of ["rect", "roundedRect", "ellipse", "triangle", "polygon", "star", "line"] as const) {
      change(select(), kind);
      act(() => button("创建形状").click());
      const params = commands.at(-1)!.params;
      expect(params.kind, kind).toBe(kind === "triangle" ? "polygon" : kind);
      expect(decodeVectorShapeParams(params), `${kind} 必须被协议接受`).not.toBeNull();
    }
  });

  it("三角形按 polygon+sides:3 提交，回填时仍显示为三角形", () => {
    // 快照里三角形是 wire 形态：kind polygon、sides 3、star_ratio 1（正多边形哨兵值）。
    const triangle = { ...shape, kind: "polygon", live: { kind: "polygon", rect: [10, 20, 100, 60], sides: 3, star_ratio: 1 } };
    const { container, button, commands } = setup({ snapshot: { shapes: [triangle], vectorMasks: [], paths: [] } });
    const properties = container.querySelector("[data-shape-properties]")!;
    // 回填时换回界面种类，否则刚画好的三角形会显示成「多边形」。
    expect(properties.textContent).toContain("三角形");
    expect(properties.textContent).not.toContain("多边形");
    // 直接保存不做修改，也必须仍编译成内核认识的 polygon + sides: 3，而不是 triangle。
    act(() => button("编辑形状属性").click());
    act(() => button("应用属性").click());
    const edit = commands.at(-1)!;
    expect(edit.id).toBe("shape.edit");
    expect(edit.params.kind).toBe("polygon");
    expect(edit.params.sides).toBe(3);
  });

  it("选中形状时按快照回填属性，编辑走同一步 shape.edit", () => {    const { container, button, commands, type, labelled } = setup({ snapshot: { shapes: [shape], vectorMasks: [], paths: [] } });
    expect(container.querySelector("[data-shape-properties]")).not.toBeNull();
    act(() => button("编辑形状属性").click());
    // 描边回填：宽度/对齐/线帽/拐角/虚线都来自快照，而不是默认值。
    const numbers = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')].map(node => node.value);
    expect(numbers).toContain("3");
    expect([...container.querySelectorAll<HTMLSelectElement>("select")].map(node => node.value)).toEqual(expect.arrayContaining(["inside", "round", "bevel"]));
    expect(labelled("虚线")!.value).toBe("4 2");
    // 改圆角后确认：只发一条 shape.edit，不新增形状。
    // 草稿区也有「圆角」输入（当前值为 0），属性编辑必须限定在选中形状的区块内取框。
    const properties = container.querySelector("[data-shape-properties]")!;
    const radius = labelled("圆角", properties) as HTMLInputElement;
    expect(radius.value).toBe("8");
    type(radius, "12");
    act(() => button("应用属性").click());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.id).toBe("shape.edit");
    expect(commands[0]!.params).toMatchObject({ layer: 3, rect: [10, 20, 100, 60], radii: [12, 12, 12, 12], fill: "#3366cc" });
    expect(commands[0]!.params.stroke).toMatchObject({ width: 3, align: "inside", cap: "round", join: "bevel", dashes: [4, 2], dashOffset: 1 });
  });

  it("属性编辑的尺寸与圆角都经同一步提交，取消不留历史", () => {
    const { container, button, commands, type, labelled } = setup({ snapshot: { shapes: [shape], vectorMasks: [], paths: [] } });
    act(() => button("编辑形状属性").click());
    const properties = container.querySelector("[data-shape-properties]")!;
    // 属性区的尺寸输入回填自快照的 `live.rect`，改宽高后仍是同一个矩形起点。
    const width = labelled("宽", properties) as HTMLInputElement;
    const height = labelled("高", properties) as HTMLInputElement;
    expect(width.value).toBe("100");
    expect(height.value).toBe("60");
    type(width, "120");
    type(height, "80");
    act(() => button("应用属性").click());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.id).toBe("shape.edit");
    expect(commands[0]!.params).toMatchObject({ layer: 3, rect: [10, 20, 120, 80], radii: [8, 8, 8, 8] });
  });

  it("取消属性编辑丢弃草稿，不发命令", () => {
    const { button, commands, container } = setup({ snapshot: { shapes: [shape], vectorMasks: [], paths: [] } });
    act(() => button("编辑形状属性").click());
    act(() => button("取消").click());
    expect(commands).toEqual([]);
    expect(container.querySelector("[data-shape-properties]")?.textContent).toContain("编辑形状属性");
  });

  it("布尔运算按选中形状层数启用，并说明层序", () => {
    const { button, commands } = setup({ snapshot: { shapes: [shape], vectorMasks: [], paths: [] } });
    act(() => button("合并形状").click());
    expect(commands[0]).toEqual({ id: "layer.combineShapes.unite", params: {} });
    act(() => button("合并形状组件").click());
    expect(commands[1]).toEqual({ id: "layer.combineShapes.mergeShapeComponents", params: { tolerance: 0.1 } });
  });

  it("形状层不足两个时布尔按钮禁用并显示原因", () => {
    const controller = {} as unknown as EditorWorkspaceController;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(
      <VectorToolsPanel controller={{
        ...controller,
        vectorSnapshot: () => ({ ok: true, value: { shapes: [], vectorMasks: [], paths: [] } }),
        features: { vectors: { vectorPresets: () => ({ ok: true, value: { groups: [], custom: [] } }) } },
        vectorCommand: () => ({ ok: true, value: {} }),
      } as unknown as EditorWorkspaceController} readonly={false} layer={null} color="#000000" hasSelection={false} revision={1} shapeLayers={1} />,
    ));
    const unite = [...container.querySelectorAll("button")].find(node => node.textContent === "合并形状")!;
    expect(unite.disabled).toBe(true);
    expect(unite.title).toBe("请先选中形状图层");
    expect(container.textContent).toContain("先在图层列表选中形状图层");
  });

  it("矢量蒙版：全显/全隐、参数编辑与栅格化分派到对应命令", () => {
    const mask = { layer: 3, enabled: true, linked: true, density: 1, feather: 0, inverted: false };
    const { button, commands, type, labelled } = setup({ snapshot: { shapes: [], vectorMasks: [mask], paths: [] } });
    act(() => button("全显").click());
    act(() => button("全隐").click());
    expect(commands.slice(0, 2)).toEqual([
      { id: "layer.vectorMask.revealAll", params: { layer: 3, hide: false } },
      { id: "layer.vectorMask.hideAll", params: { layer: 3, hide: true } },
    ]);
    // 密度输入按 0–100 显示百分比，提交时回到内核的 0–1。
    const density = labelled("密度") as HTMLInputElement;
    expect(density.value).toBe("100");
    type(density, "40");
    expect(commands.at(-1)).toEqual({ id: "layer.vectorMask.edit", params: { layer: 3, density: 40 } });
    act(() => button("栅格化矢量蒙版").click());
    expect(commands.at(-1)).toEqual({ id: "layer.rasterize.vectorMask", params: { layer: 3 } });
  });

  it("路径变换、裁切与选区转换都在面板内可达", () => {
    const { button, commands } = setup();
    act(() => button("旋转 90°").click());
    expect(commands.at(-1)).toMatchObject({ id: "path.transform", params: { name: "work", matrix: [expect.any(Number), 1, -1, expect.any(Number), 0, 0] } });
    act(() => button("设为裁切路径").click());
    expect(commands.at(-1)).toEqual({ id: "path.clippingPath.set", params: { name: "work", flatness: 0 } });
    act(() => button("选区转形状").click());
    expect(commands.at(-1)).toMatchObject({ id: "select.convertToShape", params: { tolerance: 2, fill: "#3366cc" } });
    act(() => button("路径转选区").click());
    expect(commands.at(-1)).toEqual({ id: "path.toSelection", params: { name: "work", feather: 0, mode: "replace" } });
  });

  it("预设库来自本域工具状态，删除只改库不改已应用形状", () => {
    const library = { groups: [{ name: "Symbols", shapes: [{ name: "Star", digest: "0123456789abcdef", subpaths: 1 }] }], custom: [{ name: "箭头", digest: "fedcba9876543210", subpaths: 1 }] };
    const { container, commands, button, change } = setup({ library, snapshot: { shapes: [shape], vectorMasks: [], paths: [] } });
    const options = [...container.querySelectorAll("option")].map(node => node.textContent);
    // 预设选择器是最后一个含预设选项的 `<select>`（前面的下拉是形状种类/填充规则/描边属性）。
    const select = [...container.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value.includes("Symbols")))!;
    expect(options).toContain("Symbols · Star");
    expect(options).toContain("自定形状 · 箭头");
    change(select, "Symbols\u0000Star");
    act(() => button("放置预设").click());
    expect(commands.at(-1)).toMatchObject({ id: "shape.presets.place", params: { preset: "Star", group: "Symbols", rect: [0, 0, 100, 100] } });
    // 内置组里的预设必须带组名：内核按 `group` 收窄查找，否则全库重名会失配。
    act(() => button("删除所选预设").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "delete", preset: "Star", group: "Symbols" } });
    // 已应用的形状仍在快照里——库操作不碰文档几何。
    expect(container.querySelector("[data-shape-properties]")).not.toBeNull();
  });

  it("自定形状不带组名，内置预设带组名（与内核的查找口径一致）", () => {
    const library = { groups: [{ name: "Symbols", shapes: [{ name: "Star", digest: "0123456789abcdef", subpaths: 1 }] }], custom: [{ name: "箭头", digest: "fedcba9876543210", subpaths: 1 }] };
    const { container, commands, button, change } = setup({ library });
    const select = [...container.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value.includes("Symbols")))!;
    // 自定形状：合成组，内核里不在 `presets.shapes`，带组名会被拒。
    change(select, "自定形状\u0000箭头");
    act(() => button("删除所选预设").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "delete", preset: "箭头" } });
  });

  it("重命名所选预设与移动分组都按组的真实归属提交", () => {
    const library = { groups: [{ name: "Symbols", shapes: [{ name: "Star", digest: "0123456789abcdef", subpaths: 1 }] }], custom: [{ name: "箭头", digest: "fedcba9876543210", subpaths: 1 }] };
    const { container, commands, button, change, type, labelled } = setup({ library });
    const select = [...container.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value.includes("Symbols")))!;
    change(select, "Symbols\u0000Star");
    type(labelled("重命名为") as HTMLInputElement, "Star2");
    act(() => button("重命名所选预设").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "rename", preset: "Star", name: "Star2", group: "Symbols" } });
    // 重命名后清空选择，避免继续对旧名字操作。
    expect(select.value).toBe("");

    change(select, "Symbols\u0000Star");
    type(labelled("移动到") as HTMLInputElement, "Arrows");
    act(() => button("移动到分组").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "move", preset: "Star", group: "Symbols", to: "Arrows" } });
  });

  it("自定形状不可在组间移动（上游不支持），按钮禁用并说明原因", () => {
    const library = { groups: [{ name: "Symbols", shapes: [{ name: "Star", digest: "0123456789abcdef", subpaths: 1 }] }], custom: [{ name: "箭头", digest: "fedcba9876543210", subpaths: 1 }] };
    const { container, change } = setup({ library });
    const select = [...container.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value.includes("Symbols")))!;
    change(select, "自定形状\u0000箭头");
    const move = [...container.querySelectorAll("button")].find(node => node.textContent === "移动到分组")!;
    expect(move.disabled).toBe(true);
    expect(move.title).toContain("上游不支持在组间移动");
  });

  it("分组的建立/重命名/删除都走 shape.presets.edit", () => {
    const library = { groups: [{ name: "Symbols", shapes: [{ name: "Star", digest: "0123456789abcdef", subpaths: 1 }] }], custom: [] };
    const { commands, button, type, labelled, change } = setup({ library });
    type(labelled("分组名称") as HTMLInputElement, "Mine");
    act(() => button("新建分组").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "newGroup", name: "Mine" } });

    // 重命名/删除分组需要先在下拉里选中真实分组。
    act(() => change(labelled("管理分组") as HTMLSelectElement, "Symbols"));
    type(labelled("分组名称") as HTMLInputElement, "Icons");
    act(() => button("重命名分组").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "renameGroup", group: "Symbols", name: "Icons" } });

    act(() => change(labelled("管理分组") as HTMLSelectElement, "Symbols"));
    act(() => button("删除分组").click());
    expect(commands.at(-1)).toEqual({ id: "shape.presets.edit", params: { action: "deleteGroup", group: "Symbols" } });
  });

  it("只读时所有写入入口禁用", () => {
    const { buttons } = setup({ readonly: true, snapshot: { shapes: [shape], vectorMasks: [], paths: [] } });
    for (const node of buttons()) expect(node.disabled).toBe(true);
  });
});
