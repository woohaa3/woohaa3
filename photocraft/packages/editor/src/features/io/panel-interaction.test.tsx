/** @vitest-environment jsdom */
/**
 * 面板交互回归（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 用替身会话验证面板语义：真实预览显示编码尺寸、交付报告失败项可见、只读时动作禁用、
 * 矩阵行来自内核而非前端常量。真实编码像素与打包在 Rust 侧测试。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InterchangePanel } from "./panels.js";
import { requestInterchange, resetInterchangeRequest } from "./menu-request.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

function controller(overrides: Record<string, unknown> = {}, selected: number[] = []) {
  const calls: string[] = [];
  const io = {
    matrix: () => {
      calls.push("matrix");
      return {
        ok: true,
        value: {
          formats: [
            {
              id: "png", name: "PNG", extensions: ["png", "apng"], mime: "image/png",
              read: true, write: true, depths: ["U8"], layouts: ["rgba"],
              alpha: true, icc: true, exif: true, xmp: true, dpi: true,
              text: false, animation: true, lossy: false,
              status: "open", reason: null, exportable: true
            },
            {
              id: "exr", name: "OpenEXR", extensions: ["exr"], mime: "image/x-exr",
              read: false, write: false, depths: [], layouts: [],
              alpha: true, icc: false, exif: false, xmp: true, dpi: false,
              text: false, animation: false, lossy: true,
              status: "deferred", reason: "未编入 WASM", exportable: false
            }
          ]
        }
      };
    },
    exportOptions: () => {
      calls.push("export-options");
      // 真实 `exportMatrixJson()` 的形状：每行带自己支持的参数集合。
      return {
        ok: true,
        value: [
          { format: "jpg", options: ["quality", "chromaSubsampling", "metadata", "embedIcc", "width", "height", "percent"] },
          { format: "webp", options: ["webpLossless", "webpQuality", "metadata", "embedIcc", "width", "height", "percent", "transparency"] },
          { format: "png", options: ["pngCompression", "interlaced", "metadata", "embedIcc", "width", "height", "percent", "transparency"] }
        ]
      };
    },
    inspectOpenRaster: () => ({ ok: true, value: { openable: true, format: "png" } }),
    previewExport: (settings: unknown) => {
      calls.push(`preview:${JSON.stringify(settings)}`);
      return {
        ok: true,
        value: {
          fileName: "art.jpg",
          contentType: "image/jpeg",
          bytes: new Uint8Array([1, 2, 3]),
          report: {
            width: 40,
            height: 30,
            bytes: 3,
            lossy: true,
            // 内核真实会报的能力损失（GIF 量化 / DPI 丢弃）。
            warnings: ["colours will be quantized to a 256-colour palette", "resolution (DPI) not supported; it will be dropped"]
          }
        }
      };
    },
    exportRaster: () => { calls.push("export"); return { ok: true, value: { fileName: "art.jpg", contentType: "image/jpeg", bytes: new Uint8Array([1]) } }; },
    inspectLayerExport: (params: unknown) => {
      calls.push(`layer-plan:${JSON.stringify(params)}`);
      return {
        ok: true,
        value: {
          kind: "layers",
          layers: [
            { fileName: "a.png", layerId: 1, width: 8, height: 6 },
            { fileName: "b.png", layerId: 2, empty: true, error: "无可见像素" }
          ],
          files: [{ fileName: "b.png", ok: false, error: "无可见像素" }],
          rejected: [{ layerId: 3, reason: "目标图层已失效" }],
          renames: [{ original: "同名", delivered: "同名-2.png", reason: "重名已追加序号" }]
        }
      };
    },
    exportLayerBundle: (params: unknown) => {
      calls.push(`layer-bundle:${JSON.stringify(params)}`);
      return { ok: true, value: { fileName: "art-图层.zip", contentType: "application/zip", bytes: new Uint8Array([1]) } };
    },
    exportLayerAs: () => ({ ok: true, value: { fileName: "art-a.png", contentType: "image/png", bytes: new Uint8Array([1]) } }),
    inspectImageAssets: () => { calls.push("inspectImageAssets"); return { ok: true, value: { kind: "assets", assets: [{ fileName: "图标.png", layerId: 2, width: 8, height: 6 }] } }; },
    exportImageAssets: () => ({ ok: true, value: { fileName: "art-assets.zip", contentType: "application/zip", bytes: new Uint8Array([1]) } }),
    ...overrides
  };
  const view = {
    hasDocument: true,
    document: { name: "art", revision: 3, selectedLayerIds: selected, layers: [] }
  };
  return {
    calls,
    view,
    controller: {
      features: { io },
      currentView: () => view
    } as never
  };
}

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(element));
  return container;
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;

it("面板读到真实矩阵与可导出格式，暂缓格式带原因显示", () => {
  const { controller: c, calls } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  expect(calls).toContain("matrix");
  expect(calls).toContain("export-options");
  // 导出格式下拉只来自内核矩阵，不是前端常量表。
  const formats = [...container.querySelectorAll<HTMLOptionElement>("option")].map((option) => option.value);
  expect(formats).toContain("jpg");
  expect(formats).toContain("webp");
  act(() => button(container, "格式矩阵").click());
  const text = container.textContent ?? "";
  expect(text).toContain("OpenEXR");
  expect(text).toContain("暂缓");
  expect(text).toContain("未编入 WASM");
  // U05 的矩阵含位深/布局/Alpha/metadata/feature：漏掉任一项都会被误读成「不支持」。
  const png = container.querySelector('[data-io-matrix-row="png"]')?.textContent ?? "";
  expect(png).toContain("U8");
  expect(png).toContain("rgba");
  expect(png).toContain("Alpha");
  expect(png).toContain("png/apng");
  expect(png).toContain("ICC");
  expect(png).toContain("EXIF");
  expect(png).toContain("XMP");
  expect(png).toContain("DPI");
  expect(png).toContain("动画");
  expect(png).not.toContain("有损");
  const exr = container.querySelector('[data-io-matrix-row="exr"]')?.textContent ?? "";
  expect(exr).toContain("有损");
  expect(exr).toContain("XMP");
});

it("真实预览显示编码尺寸与字节数，交付给出下载提示且声明不等于保存", () => {
  const { controller: c, calls } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  const fetchUrl = vi.fn(() => "blob:preview-1");
  const revokeUrl = vi.fn();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  (URL as unknown as { createObjectURL: typeof fetchUrl }).createObjectURL = fetchUrl;
  (URL as unknown as { revokeObjectURL: typeof revokeUrl }).revokeObjectURL = revokeUrl;
  try {
    act(() => button(container, "真实预览").click());
    expect(calls.some((call) => call.startsWith("preview:"))).toBe(true);
    expect(container.querySelector("[data-io-preview]")?.textContent).toContain("40 × 30");
    expect(container.querySelector<HTMLImageElement>("[data-io-preview] img")?.src).toBe("blob:preview-1");
    act(() => button(container, "导出并下载").click());
    expect(calls).toContain("export");
    expect(container.textContent).toContain("已发起下载：art.jpg");
    expect(container.textContent).toContain("下载不等于已保存工程");
  } finally {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = originalCreate;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = originalRevoke;
  }
});

it("逐层计划按当前选择传参，并显示空层与失败原因", () => {
  const { controller: c, calls } = controller({}, [4, 5]);
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  act(() => button(container, "逐层与资产").click());
  act(() => button(container, "查看逐层计划").click());
  expect(calls).toContain('layer-plan:{"format":"png","layers":[4,5]}');
  const plan = container.querySelector("[data-io-layer-plan]")?.textContent ?? "";
  expect(plan).toContain("a.png");
  expect(plan).toContain("跳过：无可见像素");
  expect(container.textContent).toContain("b.png：无可见像素");
});

it("逐层格式可选，计划与打包都用同一格式", () => {
  const { controller: c, calls } = controller({}, [4]);
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  act(() => button(container, "逐层与资产").click());
  const format = [...container.querySelectorAll<HTMLSelectElement>("select")]
    .find((node) => [...node.options].some((option) => option.value === "webp"))!;
  act(() => {
    format.value = "webp";
    format.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button(container, "查看逐层计划").click());
  expect(calls).toContain('layer-plan:{"format":"webp","layers":[4]}');
  act(() => button(container, "逐层打包下载").click());
  expect(calls).toContain('layer-bundle:{"format":"webp","layers":[4]}');
});

it("按名称资产计划列出命名后的文件", () => {
  const { controller: c, calls } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  act(() => button(container, "逐层与资产").click());
  act(() => button(container, "查看资产计划").click());
  expect(calls).toContain("inspectImageAssets");
  expect(container.querySelector("[data-io-asset-plan]")?.textContent).toContain("图标.png");
});

it("切换文档后不再显示上一份文档的逐层/资产计划", () => {
  const { controller: c, view } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  act(() => button(container, "逐层与资产").click());
  act(() => button(container, "查看逐层计划").click());
  act(() => button(container, "查看资产计划").click());
  expect(container.querySelector("[data-io-layer-plan]")).not.toBeNull();
  expect(container.querySelector("[data-io-asset-plan]")).not.toBeNull();

  // 换文档：名字/尺寸/修订号/活动标签都变了。旧计划描述的是上一份文档，
  // 而「打包下载」用的是当前文档——继续显示会让界面清单与实际交付对不上。
  view.document = { name: "other", revision: 1, width: 48, height: 32, selectedLayerIds: [], layers: [] } as never;
  act(() => root.render(<InterchangePanel controller={c} readonly={false} />));
  expect(container.querySelector("[data-io-layer-plan]")).toBeNull();
  expect(container.querySelector("[data-io-asset-plan]")).toBeNull();
  expect(container.querySelector("[data-io-renames]")).toBeNull();
});

it("同一文档内改动内容或选择后，旧计划与旧预览也失效", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:preview-1";
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  try {
    const { controller: c, view } = controller({}, [4]);
    const container = render(<InterchangePanel controller={c} readonly={false} />);
    act(() => button(container, "真实预览").click());
    expect(container.querySelector("[data-io-preview]")).not.toBeNull();
    act(() => button(container, "逐层与资产").click());
    act(() => button(container, "查看逐层计划").click());
    expect(container.querySelector("[data-io-layer-plan]")).not.toBeNull();

    // 同一份文档被编辑（修订号推进）：旧预览与旧计划不再是当前输入的快照。
    view.document = { ...view.document, revision: 4 } as never;
    act(() => root.render(<InterchangePanel controller={c} readonly={false} />));
    expect(container.querySelector("[data-io-layer-plan]")).toBeNull();
    // 回到导出页签确认预览也被撤下（它持有旧画布的 blob URL）。
    act(() => button(container, "导出").click());
    expect(container.querySelector("[data-io-preview]")).toBeNull();
  } finally {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = originalCreate;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = originalRevoke;
  }
});

it("内核失败时显示原因而不是静默成功", () => {
  const { controller: c } = controller({ previewExport: () => ({ ok: false, code: "invalid-export-settings", message: "质量必须在 1–100 之间" }) });
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  act(() => button(container, "真实预览").click());
  expect(container.textContent).toContain("质量必须在 1–100 之间");
  expect(container.querySelector("[data-io-preview]")).toBeNull();
});

it("改设置或预览失败都撤下旧预览，不拿旧候选配新参数", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoke = vi.fn();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:preview-1";
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revoke;
  try {
    let fail = false;
    const io = () => ({
      ok: !fail,
      value: fail ? undefined : { bytes: new Uint8Array([1]), contentType: "image/jpeg", report: { width: 8, height: 6, bytes: 1 } },
      message: fail ? "编码失败" : undefined
    });
    const { controller: c } = controller({ previewExport: () => io() });
    const container = render(<InterchangePanel controller={c} readonly={false} />);
    act(() => button(container, "真实预览").click());
    expect(container.querySelector("[data-io-preview]")).not.toBeNull();
    // 改格式：旧图必须撤下并释放对象 URL。
    const format = [...container.querySelectorAll<HTMLSelectElement>("select")]
      .find((node) => [...node.options].some((option) => option.value === "webp"))!;
    act(() => {
      format.value = "webp";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("[data-io-preview]")).toBeNull();
    expect(revoke).toHaveBeenCalled();
    // 再预览一次并让它失败：也不能把上一次的图留下。
    act(() => button(container, "真实预览").click());
    expect(container.querySelector("[data-io-preview]")).not.toBeNull();
    fail = true;
    act(() => button(container, "真实预览").click());
    expect(container.querySelector("[data-io-preview]")).toBeNull();
    expect(container.textContent).toContain("编码失败");
  } finally {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = originalCreate;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = originalRevoke;
  }
});

it("把内核的编码损失与计划拒绝项显示出来，不只报成功", () => {
  const { controller: c } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  const fetchUrl = vi.fn(() => "blob:preview-warn");
  const revokeUrl = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: fetchUrl, revokeObjectURL: revokeUrl });

  act(() => button(container, "真实预览").click());
  // 预览成功但存在不可逆损失：必须逐条说出来。
  const warnings = container.querySelector("[data-io-warnings]");
  expect(warnings?.textContent).toContain("quantized to a 256-colour palette");
  expect(warnings?.textContent).toContain("DPI");

  // 逐层计划：被拒绝的目标与改名原因都要可见，否则用户以为全都导出了。
  act(() => button(container, "逐层与资产").click());
  act(() => button(container, "查看逐层计划").click());
  const text = container.textContent ?? "";
  expect(text).toContain("目标图层已失效");
  expect(container.querySelector("[data-io-renames]")?.textContent).toContain("同名 → 同名-2.png");
});

it("只读时导出与打包动作全部禁用，矩阵仍可查看", () => {
  const { controller: c } = controller();
  const container = render(<InterchangePanel controller={c} readonly={true} />);
  expect(button(container, "真实预览").disabled).toBe(true);
  expect(button(container, "导出并下载").disabled).toBe(true);
  expect(button(container, "格式矩阵").disabled).toBe(false);
  act(() => button(container, "逐层与资产").click());
  expect(button(container, "逐层打包下载").disabled).toBe(true);
  expect(button(container, "生成资产包下载").disabled).toBe(true);
  expect(button(container, "导出当前图层").disabled).toBe(true);
});

it("参数控件由内核的格式能力驱动，不显示必然失败的开关", () => {
  const { controller: c } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  // 默认 jpg：内核声明没有 transparency，就不该出现「保留透明」。
  expect(container.textContent).not.toContain("保留透明");
  expect(container.textContent).toContain("色度抽样");

  const formatSelect = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith("格式"))!
    .querySelector("select")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(formatSelect, "png");
    formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // 换成 png：出现透明与交错，色度抽样消失。
  expect(container.textContent).toContain("保留透明");
  expect(container.textContent).toContain("交错");
  expect(container.textContent).not.toContain("色度抽样");
});

it("Save for Web 显示的质量就是内核实际用的那个（60），不是 Export As 的 90", () => {
  const { controller: c } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  // 切到 web 模式
  const modeSelect = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith("模式"))!
    .querySelector("select")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(modeSelect, "web");
    modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // 默认格式是 png24：Save for Web 走自己的优化器，不读 `pngCompression`，
  // 摆出这个下拉会让用户以为调了压缩级别。
  expect(container.textContent).not.toContain("PNG 压缩");
  expect(container.textContent).toContain("交错");

  // 切到 jpeg（web 的格式词）才能看到质量输入
  const formatSelect = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith("格式"))!
    .querySelector("select")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(formatSelect, "jpeg");
    formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const quality = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith("质量"))!
    .querySelector("input")!;
  // 界面数字必须等于内核 `WebSettings::default()` 的 60；显示 90 会让人以为交付质量更高。
  expect(quality.value).toBe("60");
});

it("设置一改就用内核预检显示目标尺寸；参数非法时不显示", () => {
  const { controller: c } = controller({
    inspectExport: (settings: { width?: number; height?: number; percent?: number }) => {
      if (settings.width === 0) return { ok: false, message: "宽度必须为正整数" };
      return { ok: true, value: { width: settings.width ?? 32, height: settings.height ?? 24 } };
    }
  });
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  expect(container.querySelector('[data-io-target-size="true"]')?.textContent).toBe("目标尺寸 32 × 24");

  const widthLabel = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith("宽度"))!;
  const width = widthLabel.querySelector("input")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(width, "0");
    width.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[data-io-target-size="true"]')).toBeNull();
});

it("矩阵读不到时说明原因，而不是显示空列表", () => {
  const { controller: c } = controller({
    matrix: () => ({ ok: false, code: "capability-disabled", message: "当前编辑内核产物不支持栅格交换（缺少 inspectRaster）" })
  });
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  expect(container.textContent).toContain("当前编辑内核产物不支持栅格交换");
});

it("内核没有本域会话时面板不渲染占位入口", () => {
  const container = render(<InterchangePanel controller={{ features: {}, currentView: () => ({ hasDocument: false, document: null }) } as never} readonly={false} />);
  expect(container.textContent).toBe("");
});

it("菜单意图决定面板落在哪个模式：文件 ▸ Save for Web 直接是 web 模式", () => {
  resetInterchangeRequest();
  // 先渲染一块面板（默认是 export 模式），再模拟「文件 ▸ Save for Web…」。
  const { controller: c } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  const modeSelect = () => [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith("模式"))!
    .querySelector("select")!;
  expect(modeSelect().value).toBe("export");

  act(() => { requestInterchange({ tab: "export", mode: "web" }); });
  // web 模式只列 Save for Web 的格式词（png24/png8/gif/jpeg），不是 Export As 的 jpg/tif。
  expect(modeSelect().value).toBe("web");
  const formatOptions = [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith("格式"))!
    .querySelectorAll("option");
  expect([...formatOptions].map((node) => (node as HTMLOptionElement).value)).toEqual(["png24", "png8", "gif", "jpeg"]);
  resetInterchangeRequest();
});

it("同一菜单意图只应用一次，用户之后的切换不被覆盖", () => {
  resetInterchangeRequest();
  const { controller: c } = controller();
  const container = render(<InterchangePanel controller={c} readonly={false} />);
  act(() => { requestInterchange({ tab: "matrix" }); });
  expect(container.querySelector('[data-io-matrix="true"]')).not.toBeNull();

  // 用户手动切回「导出」：重新渲染不得把页签again 拉回菜单值。
  act(() => { button(container, "导出").click(); });
  expect(container.querySelector('[data-io-matrix="true"]')).toBeNull();
  act(() => { root.render(<InterchangePanel controller={c} readonly={false} />); });
  expect(container.querySelector('[data-io-matrix="true"]')).toBeNull();
  resetInterchangeRequest();
});
