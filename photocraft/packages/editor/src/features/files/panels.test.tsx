/** @vitest-environment jsdom */
/**
 * 本域面板与菜单入口回归（change: 2026-10-22-add-photocraft-file-workflows，U01–U04）。
 *
 * 只检查界面契约：表单提交经域会话、失败保留输入并显示原因、成功显示内核实际结果、
 * 缺少会话方法的精简宿主不渲染入口（不抛错）。不读取或绘制像素。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { FEATURE_PANELS, featureMenuSections } from "../index.js";
import { DocumentCopyPanel, DocumentPresetsPanel, FileInfoPanel, NewDocumentPanel, NewDocumentWorkspace } from "./panels.js";
import { sections } from "./sections.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function setup(element: (controller: EditorWorkspaceController) => JSX.Element, files: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // 面板在冷启动时会先 `ensureEditor()` 再建文档（内核按需加载）。替身里内核视为已就绪。
  const ensureEditor = vi.fn(async () => ({ ok: true as const, value: {} as never }));
  const controller = { features: { files }, ensureEditor } as unknown as EditorWorkspaceController;
  act(() => root!.render(element(controller)));
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.includes(label));
  // React 18 拦截 `value` 赋值以跟踪受控输入；必须走原型 setter 才会触发 onChange。
  const type = (node: HTMLInputElement | HTMLSelectElement, value: string) =>
    act(() => {
      const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const inputs = () => [...container.querySelectorAll<HTMLInputElement>("input")];
  return { container, controller, button, inputs, type };
}

/**
 * 面板会在建文档前先 `ensureEditor()`（内核按需加载）。
 * 这些用例自己构造 controller，因此同样需要这个替身，否则新建路径直接不可达。
 */
const controllerFor = (files: Record<string, unknown>) =>
  ({ features: { files }, ensureEditor: vi.fn(async () => ({ ok: true as const, value: {} as never })) } as unknown as EditorWorkspaceController);

/** 每个用例独立的成功报告，避免共享 spy 造成跨用例计数污染。 */
const createDocumentOk = (patch: Record<string, unknown> = {}) => vi.fn(() => ({
  ok: true as const,
  value: {
    name: "海报", width: 1920, height: 1080, resolution: 72, background: "white",
    documentName: "海报", recentRecorded: true,
    ...patch
  }
}));

describe("U01 新建文档面板", () => {
  it("提交经域会话，并显示内核实际尺寸/DPI/背景", async () => {
    const createDocument = createDocumentOk({ width: 1080, height: 1080, resolution: 300, background: "transparent" });
    const { button, container, inputs, type } = setup(
      (controller) => <NewDocumentPanel controller={controller} readonly={false} />,
      { createDocument }
    );
    type(inputs()[0]!, "1080");
    type(inputs()[1]!, "1080");
    type(inputs()[2]!, "300");
    // 第一个 select 是尺寸预设（自定义），背景是第二个。
    type(container.querySelectorAll("select")[1]!, "transparent");
    // 提交先加载内核（按需），因此是异步的：等它真正落到会话上。
    await act(async () => { button("新建")!.click(); });
    expect(createDocument).toHaveBeenCalledWith({
      width: 1080, height: 1080, resolution: 300, mode: "rgb", depth: 8, background: "transparent", name: "未命名"
    });
    const result = container.querySelector("[data-files-new-document-result]");
    expect(result?.textContent).toBe("已新建 1080×1080 px · 300 ppi · transparent");
  });

  it("非法输入在本地拒绝且不调用内核，输入保留", () => {
    const createDocument = createDocumentOk();
    const { button, container, inputs, type } = setup(
      (controller) => <NewDocumentPanel controller={controller} readonly={false} />,
      { createDocument }
    );
    type(inputs()[0]!, "0");
    act(() => button("新建")!.click());
    expect(createDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("宽高必须是 1–8192 的整数像素");
    expect(inputs()[0]!.value).toBe("0");
  });

  it("冷启动时先加载内核再新建，不因句柄未就绪而失败", async () => {
    const createDocument = createDocumentOk();
    const { button, container } = setup((controller) => <NewDocumentPanel controller={controller} readonly={false} />, { createDocument });
    // 真实首启路径：内核按需加载，句柄此时还不存在。「新建」必须先把它加载起来。
    await act(async () => { button("新建")!.click(); });
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalled());
    expect(container.querySelector("[data-files-new-document-result]")?.textContent).toContain("已新建");
  });

  it("内核在新建前加载失败时如实报错，不调用新建", async () => {
    const createDocument = createDocumentOk();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const ensureEditor = vi.fn(async () => ({ ok: false as const, code: "load-failed", message: "内核模块加载失败" }));
    const controller = { features: { files: { createDocument } }, ensureEditor } as unknown as EditorWorkspaceController;
    act(() => root!.render(<NewDocumentPanel controller={controller} readonly={false} />));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("新建"))!.click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("内核模块加载失败"));
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("内核失败显示原因", async () => {
    const createDocument = vi.fn(() => ({ ok: false as const, code: "command-failed", message: "当前编辑会话已有文档" }));
    const { button, container } = setup((controller) => <NewDocumentPanel controller={controller} readonly={false} />, { createDocument });
    await act(async () => { button("新建")!.click(); });
    expect(container.textContent).toContain("当前编辑会话已有文档");
  });

  it("最近簿记失败时如实提示，但仍报告已创建", async () => {
    const createDocument = createDocumentOk({ recentRecorded: false });
    const { button, container } = setup((controller) => <NewDocumentPanel controller={controller} readonly={false} />, { createDocument });
    await act(async () => { button("新建")!.click(); });
    expect(container.textContent).toContain("最近设置未能记录");
    expect(container.textContent).toContain("已新建 1920×1080 px");
  });

  it("缺少槽位时阻止新建并说明原因", () => {
    const createDocument = createDocumentOk();
    const { button, container } = setup(
      (controller) => <NewDocumentPanel controller={controller} readonly={false} disabledReason="最多同时打开 8 个文档" />,
      { createDocument }
    );
    expect(container.textContent).toContain("最多同时打开 8 个文档");
    expect(button("新建")!.disabled).toBe(true);
    act(() => button("新建")!.click());
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("宿主提供独立槽位时，新建改为产出工程字节交给宿主，不在本会话再加一份", async () => {
    // 一个编辑会话只有一个文档槽位：已有文档时再新建必须由宿主另开标签。
    const createDocument = createDocumentOk();
    const bytes = new Uint8Array([1, 2, 3]);
    const createDocumentBytes = vi.fn(async () => ({
      ok: true as const,
      value: {
        bytes,
        report: { name: "海报", width: 1080, height: 1080, resolution: 300, background: "transparent", documentName: "海报", recentRecorded: true }
      }
    }));
    const onRequestDocumentSlot = vi.fn(async () => ({ ok: true as const }));
    const { button, container } = setup(
      (controller) => <NewDocumentPanel controller={controller} readonly={false} onRequestDocumentSlot={onRequestDocumentSlot} />,
      { createDocument, createDocumentBytes }
    );
    await act(async () => { button("新建")!.click(); });
    await vi.waitFor(() => expect(onRequestDocumentSlot).toHaveBeenCalled());
    // 必须交出真实字节与用户填写的名称，宿主要能直接打开成新标签。
    expect(onRequestDocumentSlot).toHaveBeenCalledWith(bytes, expect.any(String));
    // 本会话的新建不得执行：否则第二个文档会被内核拒绝或挤掉当前文档。
    expect(createDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("已在新文档中打开");
  });

  it("槽位交付失败时如实报错，不谎称已打开", async () => {
    const createDocumentBytes = vi.fn(async () => ({
      ok: true as const,
      value: { bytes: new Uint8Array([1]), report: { name: "海报", width: 10, height: 10, resolution: 72, background: "white", documentName: "海报", recentRecorded: true } }
    }));
    const onRequestDocumentSlot = vi.fn(async () => ({ ok: false as const, reason: "最多同时打开 8 个文档" }));
    const { button, container } = setup(
      (controller) => <NewDocumentPanel controller={controller} readonly={false} onRequestDocumentSlot={onRequestDocumentSlot} />,
      { createDocument: createDocumentOk(), createDocumentBytes }
    );
    await act(async () => { button("新建")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("最多同时打开 8 个文档"));
    expect(container.textContent).not.toContain("已在新文档中打开");
  });

  it("U02：从图像文件新建，报告内核实际解码尺寸与警告", async () => {
    const createDocumentFromImage = vi.fn(() => ({
      ok: true as const,
      value: { name: "样张.png", width: 40, height: 24, warnings: ["颜色配置被忽略"] }
    }));
    const { container } = setup((controller) => <NewDocumentPanel controller={controller} readonly={false} />, {
      createDocument: createDocumentOk(),
      createDocumentFromImage
    });
    const picker = container.querySelector<HTMLInputElement>("[data-files-image-source]")!;
    expect(picker).not.toBeNull();
    expect(picker.disabled).toBe(false);
    const file = new File([new Uint8Array([1, 2, 3])], "样张.png", { type: "image/png" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(createDocumentFromImage).toHaveBeenCalled());
    expect(createDocumentFromImage).toHaveBeenCalledWith("样张.png", expect.any(Uint8Array));
    expect(container.textContent).toContain("已从图像新建 40×24 px");
    expect(container.textContent).toContain("颜色配置被忽略");
  });

  it("U02：读取失败显示原因，且不伪造已创建", async () => {
    const createDocumentFromImage = vi.fn(() => ({
      ok: false as const, code: "import-failed", message: "无法解码该图像"
    }));
    const { container } = setup((controller) => <NewDocumentPanel controller={controller} readonly={false} />, {
      createDocument: createDocumentOk(),
      createDocumentFromImage
    });
    const picker = container.querySelector<HTMLInputElement>("[data-files-image-source]")!;
    Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([9])], "x.png")], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(container.textContent).toContain("无法解码该图像"));
    expect(container.querySelector("[data-files-new-document-result]")).toBeNull();
  });
  it("U02：从剪贴板新建，用内核真实尺寸报告结果", async () => {
    const createDocumentFromImage = vi.fn(() => ({
      ok: true as const,
      value: { name: "剪贴板图像.png", width: 12, height: 9, warnings: [] }
    }));
    const clipboard = {
      clipboard: {
        read: async () => [{
          types: ["image/png"] as const,
          getType: async () => new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" })
        }]
      }
    };
    const { container } = setup(
      (controller) => <NewDocumentPanel controller={controller} readonly={false} clipboard={clipboard} />,
      { createDocument: createDocumentOk(), createDocumentFromImage }
    );
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("从剪贴板新建"))!;
    expect(button).not.toBeUndefined();
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(createDocumentFromImage).toHaveBeenCalled());
    expect(createDocumentFromImage).toHaveBeenCalledWith("剪贴板图像.png", expect.any(Uint8Array));
    expect(container.textContent).toContain("已从剪贴板新建 12×9 px");
  });

  it("U02：剪贴板不可用时说明具体原因且不调用内核", async () => {
    const createDocumentFromImage = vi.fn();
    const { container } = setup(
      // 明确禁用剪贴板：走「不支持」分支。
      (controller) => <NewDocumentPanel controller={controller} readonly={false} clipboard={null} />,
      { createDocument: createDocumentOk(), createDocumentFromImage }
    );
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("从剪贴板新建"))!;
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("不支持读取剪贴板图像"));
    expect(createDocumentFromImage).not.toHaveBeenCalled();
    expect(container.querySelector("[data-files-new-document-result]")).toBeNull();
  });
});

describe("U04 File Info 面板", () => {
  it("加载后显示已知字段与只读相机信息，写入后重新读取", () => {
    const info = {
      readFileInfo: vi.fn(() => ({ ok: true as const, value: { title: "封面", keywords: ["海报"], camera: { make: "Canon", iso: "400" } } })),
      writeFileInfo: vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: 0 } }))
    };
    const { button, container, type } = setup((controller) => <FileInfoPanel controller={controller} readonly={false} />, info);
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("封面");
    expect(container.querySelector("[data-files-camera]")?.textContent).toContain("Canon");
    type(container.querySelectorAll<HTMLInputElement>("input")[0]!, "新封面");
    act(() => button("写入 File Info")!.click());
    expect(info.writeFileInfo).toHaveBeenCalledWith(expect.objectContaining({ title: "新封面" }));
    expect(info.readFileInfo).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-files-file-info-result]")?.textContent).toContain("一步可撤销");
  });

  it("无变化的提交如实说明未新增历史，不谎称写入", () => {
    const info = {
      readFileInfo: vi.fn(() => ({ ok: true as const, value: { title: "封面", keywords: ["海报"] } })),
      writeFileInfo: vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: 0 } }))
    };
    const { button, container, type } = setup((controller) => <FileInfoPanel controller={controller} readonly={false} />, info);
    // 不做任何修改直接提交：内核不会新增历史，界面也必须在第一次提交时就说清。
    act(() => button("写入 File Info")!.click());
    expect(info.writeFileInfo).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-files-file-info-result]")?.textContent).toContain("无变化");
    expect(container.querySelector("[data-files-file-info-result]")?.textContent).not.toContain("一步可撤销");

    // 改一个字段后就应恢复成「一步可撤销」。
    type(container.querySelectorAll<HTMLInputElement>("input")[0]!, "新封面");
    act(() => button("写入 File Info")!.click());
    expect(container.querySelector("[data-files-file-info-result]")?.textContent).toContain("一步可撤销");
  });

  it("读取失败显示原因，且不显示写入按钮为可用", () => {
    const { container } = setup((controller) => <FileInfoPanel controller={controller} readonly={false} />, {
      readFileInfo: vi.fn(() => ({ ok: false as const, code: "no-document", message: "没有可读取 File Info 的文档" })),
      writeFileInfo: vi.fn()
    });
    expect(container.textContent).toContain("没有可读取 File Info 的文档");
  });

  it("精简宿主缺少会话方法时不渲染入口", () => {
    const { container } = setup((controller) => <FileInfoPanel controller={controller} readonly={false} />, {});
    expect(container.innerHTML).toBe("");
  });

  it("损失预览按所选导出格式报告，而不是永远显示工程文件无损", () => {
    const info = {
      readFileInfo: vi.fn(() => ({ ok: true as const, value: { title: "封面" } })),
      writeFileInfo: vi.fn()
    };
    const { container, type } = setup((controller) => <FileInfoPanel controller={controller} readonly={false} />, info);
    const note = () => container.querySelector("[data-files-metadata-note]");
    // 默认工程文件：完整保留。
    expect(note()?.getAttribute("data-files-loss")).toBe("none");
    expect(note()?.textContent).toContain("完整保留");

    // OpenRaster 明确不保存任何元数据：必须如实报告为损失。
    type(container.querySelector<HTMLSelectElement>("[data-files-loss-target]")!, "ora");
    expect(note()?.getAttribute("data-files-loss")).toBe("lossy");
    expect(note()?.textContent).toContain("File Info");
    expect(note()?.textContent).toContain("相机信息");

    // JPEG 保留 XMP/EXIF，只丢自由文本。
    type(container.querySelector<HTMLSelectElement>("[data-files-loss-target]")!, "jpeg");
    expect(note()?.textContent).toContain("本次会丢失：自由文本元数据");
    expect(note()?.textContent).not.toContain("本次会丢失：File Info");
  });
});

describe("U04 预设与最近面板", () => {
  it("列出预设与最近设置，删除失败保留原列表并显示原因", () => {
    const files = {
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [{ name: "方形", settings: { width: 1080, height: 1080, resolution: 300, mode: "rgb", depth: 8, background: "transparent", name: "未命名" } }] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [{ width: 640, height: 480, resolution: 72, mode: "rgb", depth: 8, background: "white", name: "未命名" }] })),
      saveDocumentPreset: vi.fn(),
      deleteDocumentPreset: vi.fn(() => ({ ok: false as const, code: "command-failed", message: "No such document preset" }))
    };
    const onUse = vi.fn();
    const { button, container } = setup((controller) => <DocumentPresetsPanel controller={controller} readonly={false} onUseSettings={onUse} />, files);
    expect(container.querySelector("[data-files-preset-list]")?.textContent).toContain("方形 — 1080×1080 px · 300 ppi · transparent");
    expect(container.querySelector("[data-files-recent-list]")?.textContent).toContain("640×480 px · 72 ppi · white");
    act(() => button("删除")!.click());
    expect(container.textContent).toContain("No such document preset");
    expect(container.querySelector("[data-files-preset-list]")?.textContent).toContain("方形");
    act(() => button("使用")!.click());
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ width: 1080 }));
  });

  it("没有当前设置时拒绝保存为预设", () => {
    const files = {
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [] })),
      saveDocumentPreset: vi.fn(),
      deleteDocumentPreset: vi.fn()
    };
    const { button, container } = setup((controller) => <DocumentPresetsPanel controller={controller} readonly={false} />, files);
    act(() => button("保存当前设置")!.click());
    expect(files.saveDocumentPreset).not.toHaveBeenCalled();
    expect(container.textContent).toContain("先在「新建文档」里设置尺寸");
  });

  it("保存后写回本机存储并如实报告已持久化", async () => {
    const settings = { width: 800, height: 600, resolution: 72, mode: "rgb" as const, depth: 8 as const, background: "white" as const, name: "未命名" };
    const saved = { name: "方形", settings };
    const files = {
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [] })),
      saveDocumentPreset: vi.fn(() => ({ ok: true as const, value: [saved] })),
      deleteDocumentPreset: vi.fn()
    };
    const store: string[] = [];
    const storage = { load: vi.fn(async () => null), save: vi.fn(async (text: string) => { store.push(text); return "saved" as const; }) };
    const { button, container } = setup(
      (controller) => <DocumentPresetsPanel controller={controller} readonly={false} spec={settings} storage={storage} />,
      files
    );
    await act(async () => { button("保存当前设置")!.click(); });
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalled());
    // 落盘内容必须是版本化信封，而不是内核原始响应。
    const parsed = JSON.parse(store[0]!);
    expect(parsed).toMatchObject({ version: 1 });
    expect(parsed.presets).toEqual([{ name: "方形", settings }]);
    await vi.waitFor(() => expect(container.querySelector("[data-files-persistence]")?.getAttribute("data-files-persistence")).toBe("saved"));
    expect(container.textContent).toContain("下次打开仍可用");
  });

  it("存储写入失败时明确降级为仅本次会话，不谎称已保存", async () => {
    const settings = { width: 800, height: 600, resolution: 72, mode: "rgb" as const, depth: 8 as const, background: "white" as const, name: "未命名" };
    const files = {
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [] })),
      saveDocumentPreset: vi.fn(() => ({ ok: true as const, value: [{ name: "方形", settings }] })),
      deleteDocumentPreset: vi.fn()
    };
    const storage = { load: vi.fn(async () => null), save: vi.fn(async () => "failed" as const) };
    const { button, container } = setup(
      (controller) => <DocumentPresetsPanel controller={controller} readonly={false} spec={settings} storage={storage} />,
      files
    );
    await act(async () => { button("保存当前设置")!.click(); });
    await vi.waitFor(() => expect(container.querySelector("[data-files-persistence]")?.getAttribute("data-files-persistence")).toBe("session"));
    expect(container.textContent).toContain("关闭后不会保存");
  });

  it("启动时把本机快照回灌内核；坏存储明确提示而不是静默清空", async () => {
    const settings = { width: 800, height: 600, resolution: 72, mode: "rgb" as const, depth: 8 as const, background: "white" as const, name: "未命名" };
    const snapshot = JSON.stringify({ version: 1, presets: [{ name: "恢复的预设", settings }], recent: [] });
    const files = {
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [] })),
      saveDocumentPreset: vi.fn(() => ({ ok: true as const, value: [] })),
      deleteDocumentPreset: vi.fn()
    };
    const good = { load: vi.fn(async () => snapshot), save: vi.fn(async () => "saved" as const) };
    const { container } = setup(
      (controller) => <DocumentPresetsPanel controller={controller} readonly={false} storage={good} />,
      files
    );
    await vi.waitFor(() => expect(files.saveDocumentPreset).toHaveBeenCalledWith("恢复的预设", settings));

    const bad = { load: vi.fn(async () => "{not json"), save: vi.fn(async () => "saved" as const) };
    const second = setup(
      (controller) => <DocumentPresetsPanel controller={controller} readonly={false} storage={bad} />,
      files
    );
    await vi.waitFor(() => expect(second.container.textContent).toContain("本机预设存储不可用"));
    expect(bad.save).not.toHaveBeenCalled();
    void container;
  });
});

describe("U02/U03 副本与恢复面板", () => {
  it("复制成功报告字节数并交出字节；没有基线时禁用恢复", () => {
    const onDuplicate = vi.fn();
    const files = {
      duplicateDocument: vi.fn(() => ({ ok: true as const, value: new Uint8Array(2048) })),
      restoreSavedBaseline: vi.fn()
    };
    // 真实装配里没有 `onDuplicate` 提供者；副本必须经本地下载真的交到用户手里。
    const downloads: { href: string; download: string }[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:copy") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    const createElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const node = createElement(tag);
      if (tag === "a") {
        (node as HTMLAnchorElement).click = () => {
          downloads.push({ href: (node as HTMLAnchorElement).href, download: (node as HTMLAnchorElement).download });
        };
      }
      return node;
    }) as typeof document.createElement);
    try {
      const { button, container, type } = setup((controller) => <DocumentCopyPanel controller={controller} readonly={false} onDuplicate={onDuplicate} />, files);
      type(container.querySelectorAll<HTMLInputElement>("input")[0]!, "我的副本");
      act(() => button("复制整份文档")!.click());
      expect(downloads).toEqual([{ href: "blob:copy", download: "我的副本.pcraft" }]);
      expect(onDuplicate).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("已生成副本字节（2048 字节）");
      expect(container.querySelector("[data-files-baseline]")?.getAttribute("data-files-baseline")).toBe("missing");
      expect(button("恢复到上次保存")!.disabled).toBe(true);
    } finally {
      spy.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("副本生成成功但交付失败时如实报错，不谎称已交付", () => {
    const files = {
      duplicateDocument: vi.fn(() => ({ ok: true as const, value: new Uint8Array(64) })),
      restoreSavedBaseline: vi.fn()
    };
    const originalCreate = URL.createObjectURL;
    // 模拟宿主环境没有 URL.createObjectURL（例如桌面壳里未注入）。
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    try {
      const { button, container } = setup((controller) => <DocumentCopyPanel controller={controller} readonly={false} />, files);
      act(() => button("复制整份文档")!.click());
      // 关键：不能显示「已生成副本字节」这种成功文案——用户其实拿不到文件。
      expect(container.querySelector("[data-files-copy-result]")).toBeNull();
      expect(container.textContent).toContain("未能交付");
      expect(container.textContent).toContain("64 字节");
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("没有基线时可直接重新选择工程文件，恢复按钮随之可用", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const files = {
      duplicateDocument: vi.fn(),
      restoreSavedBaseline: vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: 0 } }))
    };
    const { button, container } = setup((controller) => <DocumentCopyPanel controller={controller} readonly={false} />, files);
    // 未选择前：明确说明需重新选择，且恢复不可点（不是静默禁用）。
    expect(container.querySelector("[data-files-baseline]")?.getAttribute("data-files-baseline")).toBe("missing");
    expect(container.textContent).toContain("请重新选择工程文件");
    expect(button("恢复到上次保存")!.disabled).toBe(true);

    // 用户显式选择工程文件后，基线来源成立。
    const picker = container.querySelector<HTMLInputElement>("[data-files-baseline-source]")!;
    const file = new File([bytes], "上次保存.pcraft", { type: "application/zip" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() =>
      expect(container.querySelector("[data-files-baseline]")?.getAttribute("data-files-baseline")).toBe("available")
    );
    expect(container.textContent).toContain("上次保存.pcraft");
    expect(button("恢复到上次保存")!.disabled).toBe(false);

    act(() => button("恢复到上次保存")!.click());
    expect(files.restoreSavedBaseline).toHaveBeenCalledWith(bytes, "");
    expect(container.querySelector("[data-files-copy-result]")?.textContent).toContain("已恢复到上次保存基线");
  });

  it("重新选择空工程文件时说明原因，不把空字节当成可用基线", async () => {
    const files = { duplicateDocument: vi.fn(), restoreSavedBaseline: vi.fn() };
    const { button, container } = setup((controller) => <DocumentCopyPanel controller={controller} readonly={false} />, files);
    const picker = container.querySelector<HTMLInputElement>("[data-files-baseline-source]")!;
    Object.defineProperty(picker, "files", { value: [new File([], "空.pcraft")], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(container.textContent).toContain("所选工程文件为空"));
    expect(container.querySelector("[data-files-baseline]")?.getAttribute("data-files-baseline")).toBe("missing");
    expect(button("恢复到上次保存")!.disabled).toBe(true);
  });

  it("有基线时经域会话恢复，失败保留原因", () => {
    const files = {
      duplicateDocument: vi.fn(),
      restoreSavedBaseline: vi.fn(() => ({ ok: false as const, code: "load-failed", message: "工程不是合法的 ZIP 容器" }))
    };
    const baseline = { bytes: new Uint8Array([1, 2]), label: "上次保存的 .pcraft" };
    const { button, container } = setup((controller) => <DocumentCopyPanel controller={controller} readonly={false} baseline={baseline} />, files);
    expect(container.querySelector("[data-files-baseline]")?.getAttribute("data-files-baseline")).toBe("available");
    act(() => button("恢复到上次保存")!.click());
    expect(files.restoreSavedBaseline).toHaveBeenCalledWith(baseline.bytes, "");
    expect(container.textContent).toContain("工程不是合法的 ZIP 容器");
  });
});

describe("本域菜单/面板装配", () => {
  it("文件入口归入文件菜单，面板 id 唯一", () => {
    expect(sections.map((section) => section.id)).toEqual(["filesNewDocument", "filesCopy", "filesFileInfo"]);
    for (const section of sections) expect(section.placement).toBe("advanced");
    expect(featureMenuSections("文件").filter((section) => section.id.startsWith("files")).map((section) => section.id))
      .toEqual(["filesNewDocument", "filesCopy", "filesFileInfo"]);
    for (const panel of ["NewDocumentPanel", "FileInfoPanel", "DocumentPresetsPanel", "DocumentCopyPanel", "NewDocumentWorkspace"] as const) {
      expect(FEATURE_PANELS[panel]).toBeTypeOf("function");
    }
  });

  it("新建与预设共用一份设置：预设可保存、使用后填回新建表单", () => {
    const preset = { width: 1080, height: 1080, resolution: 300, mode: "rgb" as const, depth: 8 as const, background: "transparent" as const, name: "未命名" };
    const files = {
      createDocument: createDocumentOk(),
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [
        { name: "方形", settings: preset }
      ] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [] })),
      // 保存后返回仍含该预设的列表，避免用空数组掩盖「列表被清空」的缺陷。
      saveDocumentPreset: vi.fn(() => ({ ok: true as const, value: [{ name: "方形", settings: preset }] })),
      deleteDocumentPreset: vi.fn()
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const controller = controllerFor(files);
    act(() => root!.render(<NewDocumentWorkspace controller={controller} readonly={false} />));

    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
    // 初始表单有效：「保存当前设置」必须能拿到设置，而不是永远提示「先设置尺寸」。
    act(() => buttons().find((node) => node.textContent?.includes("保存当前设置"))!.click());
    expect(files.saveDocumentPreset).toHaveBeenCalledWith("", expect.objectContaining({ width: 1920, height: 1080 }));

    // 点「使用」把预设填回新建表单（宽高与 300 ppi 都要跟着变）。
    act(() => buttons().find((node) => node.textContent?.includes("使用"))!.click());
    const inputs = () => [...container.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs()[0]!.value).toBe("1080");
    expect(inputs()[1]!.value).toBe("1080");
    expect(inputs()[2]!.value).toBe("300");
  });

  it("新建后「最近」列表立即反映内核记录，而不是停在旧快照", async () => {
    const settings = { width: 640, height: 480, resolution: 72, mode: "rgb" as const, depth: 8 as const, background: "white" as const, name: "未命名" };
    // 内核的最近记录在新建**之后**才存在：第一次读为空，新建后能读到。
    let recorded = false;
    const files = {
      createDocument: vi.fn(() => {
        recorded = true;
        return { ok: true as const, value: { name: "未命名", width: 1920, height: 1080, resolution: 72, background: "white", state: { document: { width: 1920, height: 1080 } } } };
      }),
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: recorded ? [settings] : [] })),
      saveDocumentPreset: vi.fn(),
      deleteDocumentPreset: vi.fn(),
      recordRecentDocument: vi.fn()
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const controller = controllerFor(files);
    // 用 null 存储：本测试只关心界面是否重新读取内核，不涉及落盘。
    act(() => root!.render(<NewDocumentWorkspace controller={controller} readonly={false} storage={null} />));
    expect(container.querySelector("[data-files-recent-list]")).toBeNull();

    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("新建"))!;
    await act(async () => { createButton.click(); });

    // 新建成功后必须重新读取内核记录：否则列表停在旧快照，用户以为没记录。
    await vi.waitFor(() => expect(container.querySelector("[data-files-recent-list]")).not.toBeNull());
    expect(container.textContent).toContain("640×480");
  });

  it("新建成功后把最近设置写回本机存储，重挂载时能恢复", async () => {
    const settings = { width: 1920, height: 1080, resolution: 72, mode: "rgb" as const, depth: 8 as const, background: "white" as const, name: "未命名" };
    let stored: string | null = null;
    const storage = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (text: string) => { stored = text; return "saved" as const; })
    };
    const files = {
      createDocument: createDocumentOk(),
      listDocumentPresets: vi.fn(() => ({ ok: true as const, value: [] })),
      recentDocuments: vi.fn(() => ({ ok: true as const, value: [settings] })),
      saveDocumentPreset: vi.fn(),
      deleteDocumentPreset: vi.fn(),
      recordRecentDocument: vi.fn()
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const controller = controllerFor(files);
    act(() => root!.render(<NewDocumentWorkspace controller={controller} readonly={false} storage={storage} />));
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("新建"))!;
    await act(async () => { createButton.click(); });
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalled());
    // 快照里必须带 recent，否则「最近的新建设置」刷新后丢失。
    expect(JSON.parse(stored!)).toMatchObject({ version: 1, presets: [] });
    expect(JSON.parse(stored!).recent).toEqual([settings]);

    // 重新挂载（模拟刷新）：本机快照被回灌进内核。
    act(() => root!.unmount());
    root = createRoot(container);
    const reloaded = { ...files, recentDocuments: vi.fn(() => ({ ok: true as const, value: [] })) };
    const controller2 = { features: { files: reloaded } } as unknown as EditorWorkspaceController;
    await act(async () => { root!.render(<NewDocumentWorkspace controller={controller2} readonly={false} storage={storage} />); });
    await vi.waitFor(() => expect(reloaded.recordRecentDocument).toHaveBeenCalledWith(settings));
  });

  it("打印尺寸预设同时设置像素与 DPI", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const controller = { features: { files: { createDocument: createDocumentOk() } } } as unknown as EditorWorkspaceController;
    act(() => root!.render(<NewDocumentPanel controller={controller} readonly={false} />));
    const preset = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(preset, "a4-300");
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs[0]!.value).toBe("2480");
    expect(inputs[1]!.value).toBe("3508");
    expect(inputs[2]!.value).toBe("300");
  });

  it("精简宿主缺少最近簿记时仍可新建，且不因落盘报错", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // 只有 createDocument：没有 listDocumentPresets / recentDocuments。
    const files = {
      createDocument: vi.fn(() => ({
        ok: true as const,
        value: { width: 64, height: 64, resolution: 72, background: "white", name: "未命名", recentRecorded: false }
      }))
    };
    const storage = { load: vi.fn(async () => null), save: vi.fn(async () => "saved" as const) };
    const controller = controllerFor(files);
    act(() => root!.render(<NewDocumentWorkspace controller={controller} readonly={false} storage={storage} />));
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("新建"))!;
    await act(async () => { createButton.click(); });
    expect(files.createDocument).toHaveBeenCalledOnce();
    // 缺簿记方法时不做落盘，也不抛出；界面正常显示内核结果。
    expect(storage.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain("64×64");
  });

  it("没有文档时新建入口可用（外壳的 locked 含 !documentView，不能拿它判断只读）", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const files = { createDocument: vi.fn() };
    // 真实外壳在没有文档时 `locked` 恒为 true（`locked = … || !documentView`），
    // 只有 `readonly` 才是真正的只读信号。用 `locked` 判断会让新建在唯一可用状态被禁用。
    const context = {
      controller: { features: { files } } as unknown as EditorWorkspaceController,
      locked: true,
      readonly: false,
      documentView: null
    };
    act(() => root!.render(<>{sections[0]!.render(context as never)}</>));
    expect(container.textContent).not.toContain("独立文档槽位");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("新建"))!.disabled).toBe(false);
  });

  it("真正只读时新建入口禁用，与「没有文档」区分开", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const files = { createDocument: vi.fn() };
    const context = {
      controller: { features: { files } } as unknown as EditorWorkspaceController,
      locked: true,
      readonly: true,
      documentView: null
    };
    act(() => root!.render(<>{sections[0]!.render(context as never)}</>));
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("新建"))!.disabled).toBe(true);
  });

  it("已有文档时新建入口直接说明需要独立槽位，而不是等内核拒绝", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const files = { createDocument: vi.fn() };
    const context = {
      controller: { features: { files } } as unknown as EditorWorkspaceController,
      locked: false,
      readonly: false,
      documentView: { width: 640, height: 480 }
    };
    act(() => root!.render(<>{sections[0]!.render(context as never)}</>));
    expect(container.textContent).toContain("独立文档槽位");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("新建"))!.disabled).toBe(true);
  });
});
