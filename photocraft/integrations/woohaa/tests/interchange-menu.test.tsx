/** @vitest-environment jsdom */
/**
 * 宿主「文件」菜单接入本域导出面板的回归（change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）。
 *
 * 三处入口必须打开**同一块**面板且落点正确：
 * - 图像 ▸ 格式与导出…（域 manifest 贡献的节）
 * - 文件 ▸ 导出为…（共享菜单 → 本域面板的 export 模式）
 * - 文件 ▸ Save for Web…（同一面板的 web 模式）
 *
 * 为什么必须真的走一次界面：菜单项存在不等于功能可用。此前 dev 宿主就出现过「菜单在、
 * 功能不可用」的情况（缺 `fileDelivery` 端口），只断言菜单文案的测试抓不到这种缺陷。
 * 本文件用替身会话验证装配与落点；真实编码仍由 `wasm-integration.test.ts` 与 Rust 测试覆盖。
 */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { currentInterchangeRequest, resetInterchangeRequest } from "../../../packages/editor/src/features/io/menu-request.js";
import { setup } from "../src/test-support/photo-editor-harness.js";

/**
 * 最小本域会话替身。
 *
 * 共享层只检查 `exportRaster` 是否存在；点击菜单后本域面板会挂载并立刻读矩阵与格式能力，
 * 因此这些方法也必须存在（缺一个就会在 effect 里抛错——这正是「菜单可点但面板打不开」的形态）。
 */
function interchangeFeatures() {
  const noop = () => ({ ok: true, value: {} });
  return {
    io: {
      matrix: () => ({
        ok: true,
        value: {
          formats: [{
            id: "png", name: "PNG", extensions: ["png"], mime: "image/png", read: true, write: true,
            depths: ["U8"], layouts: ["rgba"], alpha: true, icc: true, exif: true, xmp: true, dpi: true,
            text: false, animation: true, lossy: false, status: "open", reason: null, exportable: true
          }]
        }
      }),
      exportOptions: () => ({ ok: true, value: [{ format: "png", options: ["pngCompression"] }] }),
      inspectOpenRaster: () => ({ ok: true, value: { openable: true } }),
      inspectExport: noop,
      previewExport: noop,
      exportRaster: () => ({ ok: true, value: { fileName: "art.png", contentType: "image/png", bytes: new Uint8Array([1]) } }),
      inspectLayerExport: noop,
      exportLayerBundle: noop,
      exportLayerAs: noop,
      inspectImageAssets: noop,
      exportImageAssets: noop
    }
  };
}

/** 文件菜单必备的宿主回调（缺任一项时「文件」菜单本就不渲染）。 */
function documents() {
  return { onOpenFile: vi.fn(), saveLabel: "保存工程", onSave: vi.fn(), onExportPng: vi.fn() };
}

/** 打开「文件」菜单并读出可见条目（Radix 走 portal，条目在 document.body 下）。 */
function openFileMenu(container: HTMLElement): string[] {
  const trigger = [...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")]
    .find((node) => node.textContent?.trim() === "文件")!;
  act(() => { trigger.focus(); });
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  const submenu = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === "导出");
  if (submenu) act(() => { submenu.focus(); submenu.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight",bubbles:true,cancelable:true})); });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((node) => node.textContent?.trim() ?? "");
}

it("内核提供导出端口时，「文件 → 导出」子菜单出现导出为… 与 Save for Web…，且顺序在导出 PNG 之后", () => {
  resetInterchangeRequest();
  const { container } = setup(false, { documents: documents(), features: interchangeFeatures() });
  const labels = openFileMenu(container);
  expect(labels).toContain("导出 PNG…");
  expect(labels).toContain("导出为…");
  expect(labels).toContain("Save for Web…");
  expect(labels.indexOf("导出为…")).toBeGreaterThan(labels.indexOf("导出 PNG…"));
  expect(labels.indexOf("Save for Web…")).toBe(labels.indexOf("导出为…") + 1);
});

it("旧内核没有导出端口时不显示死菜单项", () => {
  resetInterchangeRequest();
  const { container } = setup(false, { documents: documents(), features: { io: {} } });
  const labels = openFileMenu(container);
  expect(labels).toContain("导出 PNG…");
  expect(labels).not.toContain("导出为…");
  expect(labels).not.toContain("Save for Web…");
});

it("点击两个菜单项分别请求 export 与 web 落点，并真的展开本域面板", () => {
  resetInterchangeRequest();
  const { container } = setup(false, { documents: documents(), features: interchangeFeatures() });

  const click = (label: string) => {
    const items = openFileMenu(container);
    expect(items).toContain(label);
    const target = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.trim() === label)!;
    act(() => target.click());
  };

  click("导出为…");
  expect(currentInterchangeRequest()).toMatchObject({ tab: "export", mode: "export" });
  // 面板必须真的展开（高级区出现本域节），否则点击只是写了个没人消费的意图。
  expect(container.querySelector('[data-advanced-section="interchange"]')).not.toBeNull();

  click("Save for Web…");
  expect(currentInterchangeRequest()).toMatchObject({ tab: "export", mode: "web" });
  // 第二次点击产生新的意图（nonce 递增），面板才会重新落点。
  expect(currentInterchangeRequest()!.nonce).toBe(2);
});
