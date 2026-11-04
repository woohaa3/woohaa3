/**
 * Codex 生图导入（change: 2026-11-03-add-codex-image-import，任务 5）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasCommand, MediaMetadata } from "@woohaa3/contracts";
import { importCodexGeneratedImage, resetCodexImageImportReceipts } from "./import-generated-image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let codexHome: string;
let file: string;

beforeEach(() => {
  resetCodexImageImportReceipts();
  root = mkdtempSync(path.join(tmpdir(), "codex-import-"));
  codexHome = path.join(root, "codex");
  const dir = path.join(codexHome, "generated_images", "session");
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "a.png");
  writeFileSync(file, PNG);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function metadata(): MediaMetadata {
  return { storageKey: "sha256-abc", contentType: "image/png", size: PNG.length, checksum: "abc" };
}

describe("importCodexGeneratedImage", () => {
  it("写入媒体并创建挂在根组下的成品图片节点", async () => {
    const writes: Array<{ bytesBase64: string; canvasId: string }> = [];
    const commands: CanvasCommand[] = [];
    const result = await importCodexGeneratedImage({
      canvasId: "canvas-1",
      requestId: "req-1",
      index: 0,
      rootGroupId: "root-1",
      codexHome,
      paths: [file],
      importBytes: async (input) => {
        writes.push({ bytesBase64: input.bytesBase64, canvasId: input.canvasId });
        return metadata();
      },
      apply: async (next) => {
        commands.push(...next);
        return { ok: true, revision: 3 };
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.receipt).toMatchObject({ mediaRef: "sha256-abc", sha256: "abc", totalGenerated: 1, importedIndex: 0 });
    expect(writes).toHaveLength(1);
    expect(Buffer.from(writes[0]!.bytesBase64, "base64")).toEqual(PNG);
    const added = commands.find((command) => command.type === "node.add");
    expect(added).toMatchObject({
      type: "node.add",
      node: { type: "image", parentId: "root-1" },
      nodeData: { codexImageImport: true, resourceKind: "image", taskStatus: "successed" }
    });
    expect(added && added.type === "node.add" ? added.nodeData : {}).not.toHaveProperty("prompt");
    expect(added && added.type === "node.add" ? added.nodeData : {}).not.toHaveProperty("panelPrompt");
  });

  it("索引越界时不读文件，错误带 totalGenerated", async () => {
    let imported = 0;
    const result = await importCodexGeneratedImage({
      canvasId: "canvas-1",
      requestId: "req-1",
      index: 2,
      rootGroupId: "root-1",
      codexHome,
      paths: [file],
      importBytes: async () => {
        imported += 1;
        return metadata();
      },
      apply: async () => ({ ok: true, revision: 1 })
    });
    expect(result).toMatchObject({ ok: false, code: "image-index-out-of-range", totalGenerated: 1 });
    expect(imported).toBe(0);
  });

  it("路径越界时不写媒体", async () => {
    let imported = 0;
    const result = await importCodexGeneratedImage({
      canvasId: "canvas-1",
      requestId: "req-1",
      index: 0,
      rootGroupId: "root-1",
      codexHome,
      paths: ["/etc/passwd"],
      importBytes: async () => {
        imported += 1;
        return metadata();
      },
      apply: async () => ({ ok: true, revision: 1 })
    });
    expect(result).toMatchObject({ ok: false, code: "path-outside-generated-images" });
    expect(imported).toBe(0);
  });

  it("相同 requestId、index 与路径重放不重复写媒体", async () => {
    let imported = 0;
    const deps = {
      canvasId: "canvas-1",
      requestId: "req-1",
      index: 0,
      rootGroupId: "root-1",
      codexHome,
      paths: [file],
      importBytes: async () => {
        imported += 1;
        return metadata();
      },
      apply: async () => ({ ok: true as const, revision: 2 })
    };
    const first = await importCodexGeneratedImage(deps);
    const second = await importCodexGeneratedImage(deps);
    expect(first.ok && second.ok && second.duplicate).toBe(true);
    expect(imported).toBe(1);
    if (first.ok && second.ok) expect(second.receipt.nodeId).toBe(first.receipt.nodeId);
  });

  it("建节点失败时返回原始错误且不缓存回执", async () => {
    const result = await importCodexGeneratedImage({
      canvasId: "canvas-1",
      requestId: "req-1",
      index: 0,
      rootGroupId: "root-1",
      codexHome,
      paths: [file],
      importBytes: async () => metadata(),
      apply: async () => ({ ok: false, code: "conflict", message: "revision 过期" })
    });
    expect(result).toMatchObject({ ok: false, code: "conflict", message: "revision 过期" });
    let imported = 0;
    const retry = await importCodexGeneratedImage({
      canvasId: "canvas-1",
      requestId: "req-1",
      index: 0,
      rootGroupId: "root-1",
      codexHome,
      paths: [file],
      importBytes: async () => {
        imported += 1;
        return metadata();
      },
      apply: async () => ({ ok: true, revision: 4 })
    });
    expect(retry.ok).toBe(true);
    expect(imported).toBe(1);
  });
});
