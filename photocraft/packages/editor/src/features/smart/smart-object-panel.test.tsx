/** @vitest-environment jsdom */
/**
 * 智能对象面板回归（U65/U66）。
 *
 * 锁定三件事：父层替换/导出不受「已打开子文档」控制；不可用入口显示内核原因；
 * 转回图层必须显式确认才提交，且一次只提交一个。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorResult } from "../../editor-wasm.js";
import { SmartObjectPanel } from "./smart-object-panel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const ok = <T,>(value: T): EditorResult<T> => ({ ok: true, value });
const fail = (message: string): EditorResult<never> => ({ ok: false, code: "command-failed", message });

function state(overrides: Record<string, unknown> = {}) {
  return {
    layer: 4,
    smart: true,
    contentsId: 9,
    source: { kind: "embedded", fileName: "contents.pcraft", bytes: 616 },
    childOpen: false,
    canExport: true,
    canReplace: true,
    canEditContents: true,
    canConvertToLayers: true,
    exportReason: "",
    replaceReason: "",
    convertReason: "",
    editReason: "",
    reason: "",
    ...overrides
  };
}

function setup(options: {
  projection?: Record<string, unknown>;
  state?: Record<string, unknown>;
  convert?: EditorResult<unknown>;
  replace?: EditorResult<unknown>;
  exportSource?: EditorResult<{ name: string; bytes: Uint8Array }>;
  readonly?: boolean;
  layer?: number | null;
} = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const convertSmartToLayers = vi.fn(() => options.convert ?? ok({ layer: 11, group: true, layers: 3 }));
  const replaceSmartContents = vi.fn(() => options.replace ?? ok({ instances: [4] }));
  const exportSmartSource = vi.fn(() => options.exportSource ?? ok({ name: "contents.pcraft", bytes: new Uint8Array([1, 2, 3]) }));
  const controller = {
    features: {
      smart: {
        smartLayerState: vi.fn(() => ok(options.state ?? state())),
        exportSmartSource,
        convertSmartToLayers
      }
    },
    smartChildState: vi.fn(() => ok(options.projection ?? { active: false })),
    convertToSmartObject: vi.fn(() => ok({})),
    duplicateSmartObject: vi.fn(() => ok({})),
    rasterizeSmartObject: vi.fn(() => ok({})),
    beginSmartChild: vi.fn(() => ok({})),
    replaceSmartContents,
    updateSmartParent: vi.fn(() => ok({})),
    reloadSmartChild: vi.fn(() => ok({})),
    exportSmartChild: vi.fn(() => ok(new Uint8Array([9]))),
    detachSmartChild: vi.fn(() => ok({})),
    closeSmartChild: vi.fn()
  };
  const onChanged = vi.fn();
  const render = () =>
    act(() =>
      root!.render(
        <SmartObjectPanel
          // 面板只使用上面这些端口，测试替身按需收窄为控制器。
          controller={controller as never}
          readonly={options.readonly ?? false}
          layer={options.layer === undefined ? 4 : options.layer}
          revision={3}
          onChanged={onChanged}
        />
      )
    );
  render();
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(node => node.textContent === label);
    if (!found) throw new Error(`缺少按钮：${label}`);
    return found as HTMLButtonElement;
  };
  return { container, controller, convertSmartToLayers, replaceSmartContents, exportSmartSource, onChanged, button, render };
}

it("未打开子文档时替换源/导出源仍可用，并显示嵌入源信息", () => {
  const { container, exportSmartSource, button } = setup();
  expect(container.querySelector('[data-smart-state="smart"]')).not.toBeNull();
  expect(container.querySelector('[data-smart-source="embedded"]')?.textContent).toContain("contents.pcraft");
  expect(button("替换源").disabled).toBe(false);
  expect(button("导出源").disabled).toBe(false);
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:smart", revokeObjectURL: () => {} });
  act(() => button("导出源").click());
  expect(exportSmartSource).toHaveBeenCalledWith(4);
  expect(clicked).toEqual(["contents.pcraft"]);
});

it("导出失败时显示原因且不下载、不刷新视图", () => {
  // 导出是只读操作：失败既不能写出文件，也不能触发 afterWrite（那会刷新预览并看起来像已保存）。
  const { button, exportSmartSource, onChanged, container } = setup({ exportSource: fail("智能对象缺少嵌入源") });
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:smart", revokeObjectURL: () => {} });
  act(() => button("导出源").click());
  expect(exportSmartSource).toHaveBeenCalledWith(4);
  expect(clicked).toEqual([]);
  expect(onChanged).not.toHaveBeenCalled();
  expect(container.textContent).toContain("智能对象缺少嵌入源");
});

it("内核给的名字不可交付时退回固定下载名，绝不写出路径", () => {
  // 源文件名来自工程内容：可能带路径分隔符或没有扩展名，不能直接当下载名用。
  const { button } = setup({ exportSource: ok({ name: "../../外部/源", bytes: new Uint8Array([1]) }) });
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:smart", revokeObjectURL: () => {} });
  act(() => button("导出源").click());
  expect(clicked).toEqual(["smart-object.pcraft"]);
});

it("不可用入口显示内核原因，而不是静默禁用", () => {
  const { button, container } = setup({
    state: state({
      childOpen: true,
      canConvertToLayers: false,
      convertReason: "子文档仍在编辑中，请先回写或关闭子文档",
      canEditContents: false,
      editReason: "子文档已在编辑中",
      reason: "子文档仍在编辑中，请先回写或关闭子文档"
    })
  });
  expect(button("转回图层").disabled).toBe(true);
  expect(button("转回图层").title).toBe("子文档仍在编辑中，请先回写或关闭子文档");
  expect(button("编辑内容").disabled).toBe(true);
  expect(button("编辑内容").title).toBe("子文档已在编辑中");
  expect(container.querySelector('[data-smart-entry="reason"]')?.textContent).toContain("子文档仍在编辑中");
  // 父层替换/导出不受子会话影响。
  expect(button("替换源").disabled).toBe(false);
  expect(button("导出源").disabled).toBe(false);
});

it("转回图层需要先确认，确认后只提交一次并刷新视图", () => {
  const { button, convertSmartToLayers, onChanged, container } = setup();
  act(() => button("转回图层").click());
  expect(container.querySelector('[data-smart-convert-confirm="true"]')).not.toBeNull();
  expect(convertSmartToLayers).not.toHaveBeenCalled();
  act(() => button("确认转回").click());
  expect(convertSmartToLayers).toHaveBeenCalledTimes(1);
  expect(convertSmartToLayers).toHaveBeenCalledWith(4);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("换选图层后旧的确认不生效，必须对新层重新确认", () => {
  const { button, convertSmartToLayers, controller, container, render } = setup();
  act(() => button("转回图层").click());
  expect(container.querySelector('[data-smart-convert-confirm="true"]')).not.toBeNull();
  // 选中另一个智能层：确认态属于发起确认的那一层，新层必须重新确认。
  (controller.features.smart.smartLayerState as ReturnType<typeof vi.fn>).mockReturnValue(
    ok({ ...state(), layer: 8, contentsId: 11 })
  );
  act(() =>
    root!.render(
      <SmartObjectPanel controller={controller as never} readonly={false} layer={8} revision={4} onChanged={() => {}} />
    )
  );
  expect(container.querySelector('[data-smart-convert-confirm="true"]')).toBeNull();
  expect(convertSmartToLayers).not.toHaveBeenCalled();
  // 对新层重新确认后只转回新层。
  act(() => button("转回图层").click());
  act(() => button("确认转回").click());
  expect(convertSmartToLayers).toHaveBeenCalledTimes(1);
  expect(convertSmartToLayers).toHaveBeenCalledWith(8);
  void render;
});

it("转回图层取消不发命令；失败显示原因且不刷新", () => {
  const { button, convertSmartToLayers, onChanged, container } = setup({
    convert: fail("变形后的智能对象无法转回图层，请改用栅格化")
  });
  act(() => button("转回图层").click());
  act(() => button("取消").click());
  expect(convertSmartToLayers).not.toHaveBeenCalled();
  act(() => button("转回图层").click());
  act(() => button("确认转回").click());
  expect(convertSmartToLayers).toHaveBeenCalledTimes(1);
  expect(onChanged).not.toHaveBeenCalled();
  expect(container.textContent).toContain("变形后的智能对象无法转回图层");
});

it("替换源读取所选文件字节并交给内核；失败显示原因", async () => {
  const { controller, button, container } = setup({ replace: fail("替换源未通过核验：图层深度超限") });
  const input = container.querySelector<HTMLInputElement>('[data-smart-entry="replace-input"]')!;
  const file = new File([new Uint8Array([4, 5, 6])], "next.pcraft", { type: "application/octet-stream" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(controller.replaceSmartContents).toHaveBeenCalledTimes(1);
  const [layer, bytes] = controller.replaceSmartContents.mock.calls[0] as unknown as [number, Uint8Array];
  expect(layer).toBe(4);
  expect([...bytes]).toEqual([4, 5, 6]);
  expect(container.textContent).toContain("替换源未通过核验");
  expect(button("替换源").disabled).toBe(false);
});

it("读文件期间换选图层则放弃这次替换，不写入新层", async () => {
  const { controller, container } = setup();
  const input = container.querySelector<HTMLInputElement>('[data-smart-entry="replace-input"]')!;
  let deliver!: (value: ArrayBuffer) => void;
  const slow = { arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { deliver = resolve; }) } as unknown as File;
  Object.defineProperty(input, "files", { configurable: true, value: [slow] });
  act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  // 文件还没读完就换选了另一层：这次选择属于旧层，不能落到新层上。
  (controller.features.smart.smartLayerState as ReturnType<typeof vi.fn>).mockReturnValue(
    ok({ ...state(), layer: 8, contentsId: 11 })
  );
  act(() =>
    root!.render(
      <SmartObjectPanel controller={controller as never} readonly={false} layer={8} revision={4} onChanged={() => {}} />
    )
  );
  await act(async () => { deliver(new Uint8Array([7]).buffer); await Promise.resolve(); });
  expect(controller.replaceSmartContents).not.toHaveBeenCalled();
  expect(container.textContent).toContain("选中图层已变化");
});

it("转回确认期间内核变得不可用则不发命令，改为显示原因", () => {
  // 用户在确认框上停留时父文档可能已关闭/换文档：旧确认不能带着过期状态提交。
  const { button, convertSmartToLayers, controller, container } = setup();
  act(() => button("转回图层").click());
  expect(container.querySelector('[data-smart-convert-confirm="true"]')).not.toBeNull();
  (controller.features.smart.smartLayerState as ReturnType<typeof vi.fn>).mockReturnValue(
    ok(state({ canConvertToLayers: false, convertReason: "目标图层不存在", reason: "目标图层不存在" }))
  );
  act(() =>
    root!.render(
      <SmartObjectPanel controller={controller as never} readonly={false} layer={4} revision={5} onChanged={() => {}} />
    )
  );
  // 状态刷新后确认框必须收起成不可用入口，并显示内核原因。
  expect(container.querySelector('[data-smart-convert-confirm="true"]')).toBeNull();
  expect(button("转回图层").disabled).toBe(true);
  expect(button("转回图层").title).toBe("目标图层不存在");
  expect(convertSmartToLayers).not.toHaveBeenCalled();
});

it("只读阻止所有写入；非智能图层不显示父层入口", () => {
  const readonly = setup({ readonly: true });
  for (const label of ["转换为智能对象", "复制实例", "通过拷贝新建", "栅格化", "编辑内容", "替换源"]) {
    expect(readonly.button(label).disabled).toBe(true);
  }
  const plain = setup({
    state: {
      layer: 4,
      smart: false,
      childOpen: false,
      canExport: false,
      canReplace: false,
      canEditContents: false,
      canConvertToLayers: false,
      exportReason: "请先选择智能对象图层",
      replaceReason: "请先选择智能对象图层",
      convertReason: "请先选择智能对象图层",
      editReason: "请先选择智能对象图层",
      reason: "请先选择智能对象图层"
    }
  });
  expect(plain.container.querySelector('[data-smart-state="plain"]')).not.toBeNull();
  expect(plain.button("替换源").disabled).toBe(true);
  expect(plain.button("导出源").disabled).toBe(true);
  expect(plain.container.querySelector('[data-smart-entry="reason"]')?.textContent).toContain("请先选择智能对象图层");
});
