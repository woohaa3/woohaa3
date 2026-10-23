/**
 * dev 宿主控制器装配回归
 * （change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）。
 *
 * 真实缺陷背景：dev 宿主只注入了节点保存端口 `save`，没注入 `fileDelivery`，于是
 * `deliverFile()` 恒返回「当前宿主不支持本地文件保存」——「文件 ▸ 导出 PNG…」菜单在、
 * 点了没反应。
 *
 * 关键：**必须断言宿主装配本身**（`devControllerOptions`），而不是让测试自己造一个 controller。
 * 第一版用例自己配端口，反向验证时删掉宿主里的注入仍然全绿，等于没测到缺陷。
 *
 * 本文件不加载 WASM、不写盘（下载端口是替身）。
 */
import { describe, expect, it } from "vitest";
import { EditorHandle, EditorWorkspaceController, type EditorExportBundle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { DevDocumentSession } from "./dev-session.js";
import { devControllerOptions } from "./dev-controller.js";
import { devDocumentsMenu } from "./dev-documents.js";
import { createDevFileDelivery, exportFileName, exportOutcomeMessage, type DevDeliveryEnvironment } from "./dev-delivery.js";

const OPEN_HASH = "aabbccddeeff0011";
const EDITED_HASH = "1122334455667788";

function stateJson(revision: number): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "art" }] },
    document: {
      name: "art", width: 4, height: 3, mode: "Rgb", depth: 8, activeLayer: 1, selectedLayers: [1],
      hasSelection: false, canUndo: true, canRedo: false, revision, history: ["打开"], redoHistory: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
    }
  });
}

/** 替身内核：`execute` 模拟一次内容修改。 */
function fakeHandle() {
  let revision = 1;
  let hash = OPEN_HASH;
  const bundle = (): EditorExportBundle => ({
    revision, documentContentHash: hash, canvasWidth: 4, canvasHeight: 3,
    project: new Uint8Array([1, 2, 3]), output: new Uint8Array([4, 5, 6, 7])
  });
  const instance = {
    openImage: () => stateJson(revision),
    openProject: () => stateJson(revision),
    placeImage: () => stateJson(revision),
    execute: () => { revision += 1; hash = EDITED_HASH; return "null"; },
    stateJson: () => stateJson(revision),
    commandsJson: () => JSON.stringify([{
      id: "layer.delete", label: "删除图层", menu: ["Layer"], shortcut: null, params: "",
      enabled: true, disabledReason: null, needsDocument: true, allowed: true
    }]),
    allowedCommandIdsJson: () => JSON.stringify(["layer.delete"]),
    contentHash: () => hash,
    assetIdsJson: () => "[]",
    exportBundle: bundle,
    closeDocument: () => stateJson(revision)
  } as unknown as EditorInstance;
  return new EditorHandle(instance, {
    upstreamCommit: "test", upstreamVersion: "test", engineVersion: "test", formatVersion: 1
  });
}

function environment() {
  const triggered: { url: string; fileName: string }[] = [];
  const value: DevDeliveryEnvironment = {
    createObjectURL: () => "blob:dev-1",
    revokeObjectURL: () => undefined,
    trigger: (url, fileName) => { triggered.push({ url, fileName }); }
  };
  return { value, triggered };
}

async function controllerFor(env: DevDeliveryEnvironment | null) {
  const session = new DevDocumentSession();
  const downloads: { name: string }[] = [];
  // 用宿主真实的端口装配，只替换内核加载（`load` 本就是公开的测试注入点）：
  // 若这里自己重写端口，就测不到「宿主忘了注入 fileDelivery」这类缺陷。
  const controller = new EditorWorkspaceController({
    ...devControllerOptions({
      session,
      slot: "A",
      download: (_bytes, name) => { downloads.push({ name }); },
      // 文档名来自宿主的工作区记录；这里给真实值，断言交付文件名按它推导。
      documentName: () => "sample.png",
      deliveryEnvironment: env
    }),
    load: async () => ({ ok: true, value: fakeHandle() })
  });
  await controller.ensureEditor();
  const opened = await controller.openImage({ name: "art.png", assetId: "dev-art", bytes: new Uint8Array([1]) });
  expect(opened.ok).toBe(true);
  return { controller, session, downloads };
}

describe("dev 宿主控制器端口装配", () => {
  it("装配里真的注入了 fileDelivery（缺了它导出 PNG 恒失败）", () => {
    const options = devControllerOptions({
      session: new DevDocumentSession(),
      slot: "B",
      download: () => undefined,
      deliveryEnvironment: environment().value
    });
    // 缺陷版本这里是 undefined，`deliverFile` 随即返回「当前宿主不支持本地文件保存」。
    expect(typeof options.fileDelivery).toBe("function");
    // 节点保存端口与资产路径保持原样（不是本次改动对象，但不能被一起删掉）。
    expect(typeof options.save).toBe("function");
    expect(options.assetUrl?.("/assets/fonts/x.woff2")).toBe("/fonts/x.woff2");
  });

  it("导出 PNG 真的发起下载，且不推进保存基线", async () => {
    const env = environment();
    const { controller, session } = await controllerFor(env.value);
    expect(controller.canDeliverFiles()).toBe(true);

    const outcome = await controller.deliverFile("png", { fileName: "art.png" });
    expect(outcome).toEqual({ ok: true, status: "download-started" });
    expect(env.triggered).toEqual([{ url: "blob:dev-1", fileName: "art.png" }]);
    // 导出 PNG 不等于工程已保存：基线不动、未保存状态保留。
    expect(session.status().baseline).toBe(OPEN_HASH);
    expect(session.status().dirty).toBe(false);

    controller.dispose();
  });

  it("交付端口失败时原因原样带回，不伪装成功", async () => {
    const { controller } = await controllerFor(null);
    const outcome = await controller.deliverFile("png", { fileName: "art.png" });
    expect(outcome).toMatchObject({ ok: false, status: "failed" });
    expect(outcome.ok === false && outcome.message).toContain("不支持浏览器下载");
    controller.dispose();
  });

  it("改过内容后：导出 PNG 仍不推进基线，保存工程才推进", async () => {
    const { controller, session, downloads } = await controllerFor(environment().value);
    controller.dispatch("layer.delete");
    expect(session.status().dirty).toBe(true);

    await controller.deliverFile("png", { fileName: "art.png" });
    expect(session.status().dirty).toBe(true);

    const saved = await controller.save();
    expect(saved.ok).toBe(true);
    expect(session.status().dirty).toBe(false);
    // dev 的 save 端口成对交付工程 + PNG，文件名按文档名推导（不再固定 photocraft-A.*）。
    expect(downloads.map((entry) => entry.name)).toEqual(["sample.pcraft", "sample.png"]);
    controller.dispose();
  });
});

describe("dev 交付文件名", () => {
  it("去掉原扩展名再拼目标扩展名，不产生 sample.png.png", () => {
    // 真实缺陷：`document.name` 已是 sample.png，直接拼 .png 会得到 sample.png.png。
    expect(exportFileName("sample.png", "png")).toBe("sample.png");
    expect(exportFileName("photo.jpeg", "png")).toBe("photo.png");
    expect(exportFileName("多层 图.v2.tif", "png")).toBe("多层 图.v2.png");
    // 无名字/空名字时退回占位名，不能产出 ".png" 这种隐藏文件。
    expect(exportFileName(null, "png")).toBe("photocraft.png");
    expect(exportFileName("   ", "png")).toBe("photocraft.png");
    // 路径分隔符不能当扩展名分隔（避免把 a/b 变成 a）。
    expect(exportFileName("dir/a", "png")).toBe("dir/a.png");
  });
});

describe("交付结果 → 界面提示", () => {
  it("下载只报「已发起」，绝不写成已保存", () => {
    expect(exportOutcomeMessage({ ok: true, status: "download-started" }, "art.png")).toContain("已发起下载");
    expect(exportOutcomeMessage({ ok: true, status: "download-started" }, "art.png")).toContain("不等于已保存");
    expect(exportOutcomeMessage({ ok: true, status: "written" }, "art.png")).toContain("已导出");
  });

  it("取消与失败都有可读原因，不会静默无反应", () => {
    expect(exportOutcomeMessage({ ok: false, status: "cancelled" }, "art.png")).toContain("已取消");
    expect(exportOutcomeMessage({ ok: false, status: "failed", message: "磁盘已满" }, "art.png")).toBe("磁盘已满");
    // 失败但没给原因时也要有兜底文案。
    expect(exportOutcomeMessage({ ok: false, status: "failed", message: "" }, "art.png")).toBe("导出失败");
  });
});

describe("dev 文件交付端口语义", () => {
  it("空文件名与空字节明确失败，不产生 0 字节交付", async () => {
    const env = environment();
    const deliver = createDevFileDelivery(env.value);
    await expect(deliver({ fileName: "  ", contentType: "image/png", bytes: new Uint8Array([1]) }))
      .resolves.toMatchObject({ ok: false, status: "failed" });
    await expect(deliver({ fileName: "art.png", contentType: "image/png", bytes: new Uint8Array() }))
      .resolves.toMatchObject({ ok: false, status: "failed" });
    expect(env.triggered).toEqual([]);
  });

  it("复制字节：调用方后续修改不影响已发起的内容", async () => {
    const created: Blob[] = [];
    const bytes = new Uint8Array([7, 8, 9]);
    await createDevFileDelivery({
      createObjectURL: (blob) => { created.push(blob); return "blob:dev-copy"; },
      revokeObjectURL: () => undefined,
      trigger: () => undefined
    })({ fileName: "art.bin", contentType: "application/octet-stream", bytes });
    bytes.fill(0);
    expect([...new Uint8Array(await created[0]!.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  it("触发下载抛错时释放 URL 并报告失败原因", async () => {
    const revoked: string[] = [];
    const outcome = await createDevFileDelivery({
      createObjectURL: () => "blob:dev-x",
      revokeObjectURL: (url) => { revoked.push(url); },
      trigger: () => { throw new Error("下载被阻止"); }
    })({ fileName: "art.png", contentType: "image/png", bytes: new Uint8Array([1]) });
    expect(outcome).toEqual({ ok: false, status: "failed", message: "下载被阻止" });
    // 失败路径也只释放一次，不留悬挂的 blob。
    expect(revoked).toEqual(["blob:dev-x"]);
  });
});

describe("dev 宿主「文件」菜单能力装配", () => {
  /** 最小控制器替身：只提供菜单用到的两个方法。 */
  function fakeController(outcome: { ok: true; status: "download-started" } | { ok: false; status: "failed" | "cancelled"; message?: string }) {
    const calls: { kind: string; fileName?: string }[] = [];
    return {
      calls,
      deliverFile: async (kind: "project" | "png", options: { fileName?: string } = {}) => {
        calls.push({ kind, fileName: options.fileName });
        return outcome;
      }
    } as unknown as EditorWorkspaceController & { calls: typeof calls };
  }

  it("「保存」把 Promise 交回共享层，失败能被 await 捕获", async () => {
    const controller = fakeController({ ok: true, status: "download-started" });
    const failure = new Error("保存失败：磁盘已满");
    const menu = devDocumentsMenu({
      controller, documentName: "art.png",
      save: async () => { throw failure; },
      openFile: () => undefined, slots: [], activeSlot: "A",
      activate: () => true, report: () => undefined
    });
    // 缺陷版本 `onSave: () => { void apply(); }` 返回 undefined，这里会拿不到 rejection。
    await expect(menu.onSave?.()).rejects.toThrow("磁盘已满");
  });

  it("「导出 PNG…」走交付端口、文件名去重扩展名，并把结果说出来", async () => {
    const controller = fakeController({ ok: true, status: "download-started" });
    const reported: string[] = [];
    const menu = devDocumentsMenu({
      controller, documentName: "sample.png",
      save: async () => undefined,
      openFile: () => undefined, slots: [], activeSlot: "A",
      activate: () => true, report: (message) => { reported.push(message); }
    });
    menu.onExportPng?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.calls).toEqual([{ kind: "png", fileName: "sample.png" }]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("已发起下载");
    expect(reported[0]).toContain("不等于已保存");
  });

  it("导出失败/取消都有提示，不静默", async () => {
    for (const [outcome, keyword] of [
      [{ ok: false, status: "failed", message: "下载被阻止" } as const, "下载被阻止"],
      [{ ok: false, status: "cancelled" } as const, "已取消"]
    ] as const) {
      const reported: string[] = [];
      const menu = devDocumentsMenu({
        controller: fakeController(outcome), documentName: "art.png",
        save: async () => undefined,
        openFile: () => undefined, slots: [], activeSlot: "A",
        activate: () => true, report: (message) => { reported.push(message); }
      });
      menu.onExportPng?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(reported[0]).toContain(keyword);
    }
  });

  it("菜单只列已打开的文档，切换走门禁（被拒时不改活动文档）", () => {
    const activated: string[] = [];
    const menu = devDocumentsMenu({
      controller: fakeController({ ok: true, status: "download-started" }),
      documentName: "art.png",
      save: async () => undefined,
      openFile: () => undefined,
      slots: [
        { slot: "A", name: "art.png", open: true, revision: 1, contentHash: "aa", dirty: false },
        { slot: "B", name: "", open: false, revision: 0, contentHash: null, dirty: false }
      ],
      activeSlot: "A",
      activate: (slot) => { activated.push(slot); return false; },
      report: () => undefined
    });
    expect(menu.list).toEqual([{ id: "A", name: "A · art.png", active: true }]);
    menu.onActivateDocument?.("B");
    expect(activated).toEqual(["B"]);
    // 门禁拒绝时列表仍以 A 为活动；装配不擅自改写活动文档。
    expect(menu.list?.[0]?.active).toBe(true);
  });
});
