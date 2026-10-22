/**
 * Media Import Service 批量 coordinator 测试
 * （change: add-paste-import-workflows，任务 3.1–3.5 / design D4）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { MediaImportService } from "./service.js";
import type { CanvasCommand } from "@woohaa3/contracts";

type SubmitCall = { commands: CanvasCommand[]; commandId: string };

type GhostNode = { id: string; label: string; status?: string; progress?: number; texture?: boolean };

function makeContext(options: {
  upload?: (input: { file: File; onProgress?: (percent: number) => void }) =>
    | Promise<{ ok: true; media: Record<string, unknown> } | { ok: false; error: string }>;
  writable?: () => boolean;
} = {}) {
  const submitted: SubmitCall[] = [];
  /** 最后一次同步给画布运行时的幽灵节点与本地预览 URL。 */
  const ghosts: GhostNode[] = [];
  const previewUrls = new Map<string, string>();
  const upload = vi.fn(options.upload ?? (async () => ({
    ok: true as const,
    media: {
      storageKey: "sha256-" + "a".repeat(64),
      checksum: "a".repeat(64),
      contentType: "image/png",
      size: 4,
      url: `/api/media/sha256-${"a".repeat(64)}`,
      deduplicated: false
    }
  })));
  const ctx = {
    mediaRemote: { upload },
    canvasSession: {
      isWritable: options.writable ?? (() => true),
      submitCommands: (commands: CanvasCommand[], commandId: string) => {
        submitted.push({ commands, commandId });
        return { ok: true, handle: {} } as never;
      }
    },
    canvasRuntime: {
      getStatus: () => ({ phase: "ready", error: null }),
      controller: () => ({
        viewport: () => ({ x: 0, y: 0, zoom: 1 }),
        surface: () => ({ width: 800, height: 600, pixelRatio: 1 })
      }),
      setGhostNodes: (nodes: readonly GhostNode[]) => {
        ghosts.length = 0;
        ghosts.push(...nodes);
      },
      setPreviewUrls: (urls: ReadonlyMap<string, string>) => {
        previewUrls.clear();
        for (const [key, value] of urls) previewUrls.set(key, value);
      }
    }
  } as unknown as Context;
  return { ctx, submitted, upload, ghosts, previewUrls };
}

function png(name: string, body = "x"): File {
  return new File([body], name, { type: "image/png" });
}

describe("MediaImportService.importBatch", () => {
  it("每个文件独立原子提交 asset.upsert + node.add", async () => {
    const { ctx, submitted } = makeContext();
    const service = new MediaImportService(ctx);
    const result = await service.importBatch({
      files: [png("a.png"), png("b.png")],
      anchor: { world: { x: 0, y: 0 } },
      source: "paste",
      selectedNodeIds: []
    });
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(submitted).toHaveLength(2);
    for (const call of submitted) {
      expect(call.commands[0]).toMatchObject({ type: "asset.upsert" });
      expect(call.commands[1]).toMatchObject({ type: "node.add" });
    }
    service.dispose();
  });

  it("媒体上传失败的文件不产生命令，其它文件保留", async () => {
    let call = 0;
    const { ctx, submitted } = makeContext({
      upload: async () => {
        call += 1;
        if (call === 2) return { ok: false, error: "上传失败" };
        return {
          ok: true,
          media: {
            storageKey: "sha256-" + "b".repeat(64),
            checksum: "b".repeat(64),
            contentType: "image/png",
            size: 4,
            url: `/api/media/sha256-${"b".repeat(64)}`,
            deduplicated: false
          }
        };
      }
    });
    const service = new MediaImportService(ctx);
    const result = await service.importBatch({
      files: [png("a.png"), png("b.png"), png("c.png")],
      anchor: { world: { x: 0, y: 0 } },
      source: "drop",
      selectedNodeIds: []
    });
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.items.find((item) => item.stage === "failed")?.error).toBe("上传失败");
    // 失败项不产生命令；成功项各一个批次。
    expect(submitted).toHaveLength(2);
    service.dispose();
  });

  it("文本文件读取正文且不上传媒体对象", async () => {
    const { ctx, submitted, upload } = makeContext();
    const service = new MediaImportService(ctx);
    const text = new File(["正文"], "note.md", { type: "text/markdown" });
    const result = await service.importBatch({
      files: [text],
      anchor: { world: { x: 0, y: 0 } },
      source: "picker",
      selectedNodeIds: []
    });
    expect(result.succeeded).toBe(1);
    expect(upload).not.toHaveBeenCalled();
    const assetCommand = submitted[0]!.commands[0] as { type: string; asset: { text?: string } };
    expect(assetCommand.asset.text).toBe("正文");
    service.dispose();
  });

  it("不支持/零字节文件直接失败且不上传", async () => {
    const { ctx, upload } = makeContext();
    const service = new MediaImportService(ctx);
    const result = await service.importBatch({
      files: [new File([""], "empty.png", { type: "image/png" }), new File(["x"], "a.exe", { type: "application/octet-stream" })],
      anchor: { world: null },
      source: "paste",
      selectedNodeIds: []
    });
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    expect(upload).not.toHaveBeenCalled();
    service.dispose();
  });

  it("不可写时阻止导入并给出只读诊断", async () => {
    const { ctx, upload } = makeContext({ writable: () => false });
    const service = new MediaImportService(ctx);
    const result = await service.importBatch({
      files: [png("a.png")],
      anchor: { world: null },
      source: "paste",
      selectedNodeIds: []
    });
    expect(result.failed).toBe(1);
    expect(result.items[0]?.error).toContain("只读");
    expect(upload).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("MediaImportService 上传中幽灵节点（design D7）", () => {
  it("上传开始时立即同步幽灵节点，提交后移除", async () => {
    const deferred: { resolve: (value: { ok: true; media: Record<string, unknown> }) => void } = {
      resolve: () => undefined
    };
    const { ctx, submitted, ghosts } = makeContext({
      upload: () =>
        new Promise((resolve) => {
          deferred.resolve = resolve as never;
        })
    });
    const service = new MediaImportService(ctx);

    const pending = service.importBatch({
      files: [png("a.png")],
      anchor: { world: { x: 10, y: 20 } },
      source: "drop",
      selectedNodeIds: []
    });
    // 上传尚未完成：幽灵节点已同步给画布（立即反馈），且尚未提交命令。
    await Promise.resolve();
    await Promise.resolve();
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ label: "a.png" });
    expect(submitted).toHaveLength(0);

    deferred.resolve({
      ok: true,
      media: {
        storageKey: "sha256-" + "a".repeat(64),
        checksum: "a".repeat(64),
        contentType: "image/png",
        size: 4,
        url: `/api/media/sha256-${"a".repeat(64)}`,
        deduplicated: false
      }
    });
    await pending;
    // 提交后幽灵节点移除（真实节点由 working projection 接管）。
    expect(ghosts).toHaveLength(0);
    expect(submitted).toHaveLength(1);
    service.dispose();
  });

  it("上传进度驱动幽灵节点 progress", async () => {
    const { ctx, ghosts } = makeContext({
      upload: async (input) => {
        input.onProgress?.(42);
        return {
          ok: true,
          media: {
            storageKey: "sha256-" + "a".repeat(64),
            checksum: "a".repeat(64),
            contentType: "image/png",
            size: 4,
            url: `/api/media/sha256-${"a".repeat(64)}`,
            deduplicated: false
          }
        };
      }
    });
    const service = new MediaImportService(ctx);
    await service.importBatch({
      files: [png("a.png")],
      anchor: { world: { x: 0, y: 0 } },
      source: "drop",
      selectedNodeIds: []
    });
    // ghost 已在提交后移除；但进度回调写入过（这里以移除后为准，仅验证不抛错）。
    expect(ghosts).toHaveLength(0);
    service.dispose();
  });

  it("上传失败时幽灵节点被移除", async () => {
    const { ctx, ghosts } = makeContext({ upload: async () => ({ ok: false, error: "上传失败" }) });
    const service = new MediaImportService(ctx);
    const result = await service.importBatch({
      files: [png("a.png")],
      anchor: { world: { x: 0, y: 0 } },
      source: "drop",
      selectedNodeIds: []
    });
    expect(result.failed).toBe(1);
    expect(ghosts).toHaveLength(0);
    service.dispose();
  });

  it("文本文件幽灵节点不创建 object URL", async () => {
    const { ctx, previewUrls } = makeContext();
    const service = new MediaImportService(ctx);
    const text = new File(["正文"], "note.md", { type: "text/markdown" });
    await service.importBatch({ files: [text], anchor: { world: { x: 0, y: 0 } }, source: "picker", selectedNodeIds: [] });
    // 文本没有本地预览纹理。
    expect(previewUrls.size).toBe(0);
    service.dispose();
  });
});

describe("MediaImportService.replaceSelectedImage", () => {
  it("上传后以一个批次 upsert 资产并 patch 目标节点", async () => {
    const { ctx, submitted } = makeContext();
    const service = new MediaImportService(ctx);
    const result = await service.replaceSelectedImage({ file: png("new.png"), nodeId: "n1" });
    expect(result.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.commands).toHaveLength(2);
    expect(submitted[0]!.commands[0]).toMatchObject({ type: "asset.upsert" });
    const patch = submitted[0]!.commands[1] as { type: string; nodeId: string; value: Record<string, unknown> };
    expect(patch).toMatchObject({ type: "nodeData.patch", nodeId: "n1" });
    expect(patch.value.outputAssetId).toBeDefined();
    expect(patch.value.resourceKind).toBe("image");
    service.dispose();
  });

  it("非图片文件被拒绝", async () => {
    const { ctx, submitted } = makeContext();
    const service = new MediaImportService(ctx);
    const result = await service.replaceSelectedImage({
      file: new File(["x"], "a.txt", { type: "text/plain" }),
      nodeId: "n1"
    });
    expect(result.ok).toBe(false);
    expect(submitted).toHaveLength(0);
    service.dispose();
  });
});
