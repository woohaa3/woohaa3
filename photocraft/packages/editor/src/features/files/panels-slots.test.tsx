/** @vitest-environment jsdom */
/**
 * U02/U04 新增入口回归（change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 覆盖三处真实缺口：
 * 1. 「从图像新建 / 从剪贴板新建」在已有文档时也被内核拒绝——宿主提供槽位时必须走
 *    候选实例 + 独立标签，而不是让入口看起来可用、点了才失败；
 * 2. 最近文件：宿主没有字节引用时显示「需重新选择」，有字节引用才真正重开；
 * 3. 导出预设：由 io 域提供时才列出，缺失时如实说明（不自造预设）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { NewDocumentPanel, NewDocumentWorkspace, RecentFilesPanel } from "./panels.js";
import { emptyRecentFileStore, encodeRecentFileStore, recordRecentFile, type RecentFileEntry } from "@woohaa3/photocraft-protocol";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function render(files: Record<string, unknown>, element: (controller: EditorWorkspaceController) => JSX.Element, extra: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const controller = {
    features: { files, ...(extra.io === undefined ? {} : { io: extra.io }) },
    ensureEditor: vi.fn(async () => ({ ok: true as const, value: {} as never }))
  } as unknown as EditorWorkspaceController;
  act(() => root!.render(element(controller)));
  return { container, controller };
}

const clipboardWith = (bytes: number[]) => ({
  clipboard: {
    read: async () => [{
      types: ["image/png"],
      getType: async () => new Blob([new Uint8Array(bytes)], { type: "image/png" })
    }]
  }
});

const report = { name: "剪贴板图", width: 64, height: 48, warnings: [] as string[] };

describe("U02 从图像新建走独立槽位", () => {
  it("宿主提供槽位时把候选实例产出的字节交出去，而不是在本会话硬建", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const createDocumentFromImageBytes = vi.fn(async () => ({ ok: true as const, value: { bytes, report } }));
    const createDocumentFromImage = vi.fn();
    const onRequestDocumentSlot = vi.fn(async () => ({ ok: true as const }));
    const { container } = render(
      { createDocumentFromImageBytes, createDocumentFromImage },
      (controller) => <NewDocumentPanel controller={controller} readonly={false}
        clipboard={clipboardWith([1, 2, 3]) as never} onRequestDocumentSlot={onRequestDocumentSlot} />
    );
    const paste = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("从剪贴板新建"))!;
    await act(async () => { paste.click(); });
    expect(createDocumentFromImageBytes).toHaveBeenCalledTimes(1);
    // 关键：不再走「本会话直接建文档」——那在已有文档时必然被内核拒绝。
    expect(createDocumentFromImage).not.toHaveBeenCalled();
    expect(onRequestDocumentSlot).toHaveBeenCalledWith(bytes, "剪贴板图");
    expect(container.textContent).toContain("已在新文档中打开");
  });

  it("交付失败时如实报错，不显示「已在新文档中打开」", async () => {
    const createDocumentFromImageBytes = vi.fn(async () => ({ ok: true as const, value: { bytes: new Uint8Array([1]), report } }));
    const onRequestDocumentSlot = vi.fn(async () => ({ ok: false as const, reason: "最多同时打开 8 个文档" }));
    const { container } = render(
      { createDocumentFromImageBytes },
      (controller) => <NewDocumentPanel controller={controller} readonly={false}
        clipboard={clipboardWith([1]) as never} onRequestDocumentSlot={onRequestDocumentSlot} />
    );
    const paste = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("从剪贴板新建"))!;
    await act(async () => { paste.click(); });
    expect(container.textContent).toContain("最多同时打开 8 个文档");
    expect(container.textContent).not.toContain("已在新文档中打开");
  });
});

describe("U04 最近文件", () => {
  const entry = (id: string): RecentFileEntry => ({ id, name: `${id}.pcraft`, width: 100, height: 80, byteLength: 2048, savedAt: 1 });

  it("没有字节引用时显示需重新选择，按钮不可点", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const { container } = render({}, () => <RecentFilesPanel readonly={false} index={store} />);
    const reopen = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("需重新选择"));
    expect(reopen).toBeDefined();
    expect(reopen!.disabled).toBe(true);
    expect(container.textContent).toContain("重新选择");
  });

  it("有字节引用时真正调用宿主重开", async () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const reopen = vi.fn(async () => ({ ok: true as const }));
    const { container } = render({}, () => <RecentFilesPanel readonly={false} index={store} reopen={reopen} />);
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("重开"));
    expect(button!.disabled).toBe(false);
    await act(async () => { button!.click(); });
    expect(reopen).toHaveBeenCalledWith(store.entries[0]);
    expect(container.textContent).toContain("已重开");
  });

  it("重开失败的原因原样显示，不谎称成功", async () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const reopen = vi.fn(async () => ({ ok: false as const, reason: "文件字节已被释放" }));
    const { container } = render({}, () => <RecentFilesPanel readonly={false} index={store} reopen={reopen} />);
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("重开"));
    await act(async () => { button!.click(); });
    expect(container.textContent).toContain("文件字节已被释放");
    expect(container.textContent).not.toContain("已重开");
  });

  it("空索引显示「还没有打开过文件」，不是错误", () => {
    const { container } = render({}, () => <RecentFilesPanel readonly={false} index={emptyRecentFileStore()} />);
    expect(container.querySelector('[data-files-recent-files="empty"]')).not.toBeNull();
  });

  it("宿主逐条回答字节是否还在：刷新后记录仍在时显示需重新选择", async () => {
    // 真实场景：索引落盘、字节只在内存。刷新后记录还在，字节没了。
    // 只按「有没有重开端口」判断会让入口显示可点，用户点了才发现打不开。
    let store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    store = recordRecentFile(store, { ...entry("doc-2"), savedAt: 2 });
    const reopen = vi.fn(async () => ({ ok: true as const }));
    const hasBytes = (item: RecentFileEntry) => item.id === "doc-2";
    const { container } = render({}, () => (
      <RecentFilesPanel readonly={false} index={store} reopen={reopen} hasBytes={hasBytes} />
    ));
    const rows = [...container.querySelectorAll<HTMLElement>("[data-files-recent-file]")];
    const byId = (id: string) => rows.find((row) => row.dataset.filesRecentFile === id)!;
    const released = [...byId("doc-1").querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("需重新选择"))!;
    const available = [...byId("doc-2").querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.includes("重开"))!;
    expect(released.disabled).toBe(true);
    expect(available.disabled).toBe(false);
    await act(async () => { available.click(); });
    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: "doc-2" }));
  });

  it("本机快照能重新解码给面板（跨会话保留的记录仍可用）", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const text = encodeRecentFileStore(store);
    expect(JSON.parse(text).entries).toHaveLength(1);
  });

  it("索引落盘失败时如实说明「仅本次会话」，不假装已保存", () => {
    // 索引写失败只写 lastError、不改内存状态；界面上若不显示，用户会以为记录已保存，
    // 刷新后全部消失。空列表与非空列表都要能看到这条提示。
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const degraded = "本机最近文件记录保存失败（存储不可用或已满）：仅在本次会话保留";
    const { container } = render({}, () => <RecentFilesPanel readonly={false} index={store} storageError={degraded} />);
    const note = container.querySelector('[data-files-recent-files-storage="degraded"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("仅在本次会话保留");
  });

  it("空列表同样显示落盘失败原因（不是只有有记录时才提示）", () => {
    const { container } = render({}, () => (
      <RecentFilesPanel readonly={false} index={emptyRecentFileStore()} storageError="无法读取本机最近文件记录" />
    ));
    expect(container.querySelector('[data-files-recent-files-storage="degraded"]')!.textContent)
      .toContain("无法读取本机最近文件记录");
  });

  it("落盘正常时不渲染降级提示", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const { container } = render({}, () => <RecentFilesPanel readonly={false} index={store} storageError={null} />);
    expect(container.querySelector('[data-files-recent-files-storage="degraded"]')).toBeNull();
  });

  it("文档忙碌时按钮不谎称「需重新选择」（字节还在，只需先结算）", () => {
    // 两种「不可点」的原因完全不同：字节没了要重新选文件，有草稿要先结算。
    // 都写成「需重新选择」会让用户以为文件丢了。
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const reopen = vi.fn(async () => ({ ok: true as const }));
    const { container } = render({}, () => (
      <RecentFilesPanel readonly={false} index={store} reopen={reopen} documentBusy={true} />
    ));
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.trim() === "重开" || node.textContent?.includes("需重新选择"))!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("重开");
    expect(container.textContent).toContain("请先结算");
    expect(container.textContent).not.toContain("需重新选择");
  });

  it("字节确实不在时才显示「需重新选择」", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const { container } = render({}, () => (
      <RecentFilesPanel readonly={false} index={store} reopen={async () => ({ ok: true as const })} hasBytes={() => false} />
    ));
    expect(container.textContent).toContain("需重新选择");
  });
});

describe("U04 导出预设由 io 域提供", () => {
  const presetsSession = {
    listDocumentPresets: () => ({ ok: true as const, value: [] }),
    recentDocuments: () => ({ ok: true as const, value: [] }),
    saveDocumentPreset: () => ({ ok: true as const, value: [] }),
    deleteDocumentPreset: () => ({ ok: true as const, value: [] })
  };

  it("提供方存在时列出预设，点击转交给导出域", async () => {
    const applyExportPreset = vi.fn();
    const settings = { mode: "export", format: "jpg", quality: 90 };
    const { container } = render(
      presetsSession,
      (controller) => <NewDocumentWorkspace controller={controller} readonly={false} onUseExportPreset={applyExportPreset} />,
      { io: { exportPresets: () => [{ name: "JPEG 高", settings }] } }
    );
    await act(async () => {});
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("去导出"));
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(applyExportPreset).toHaveBeenCalledWith({ name: "JPEG 高", settings });
    expect(container.textContent).toContain("jpg");
  });

  it("提供方缺失时如实说明不可用，不列出自造预设", () => {
    const { container } = render(
      presetsSession,
      (controller) => <NewDocumentWorkspace controller={controller} readonly={false} />
    );
    expect(container.querySelector('[data-files-export-presets="unavailable"]')).not.toBeNull();
    expect(container.textContent).toContain("当前装配未提供该端口");
  });
});
