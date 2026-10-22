/**
 * 画布存储运维 CLI 测试（任务 8.6）。
 *
 * 直接调用 CLI 模块不现实（它是顶层脚本），因此这里对 CLI 依赖的**契约**做断言：
 * - 只暴露 health/export/verify/import 四个子命令，**没有**删除 COS 对象的命令；
 * - 底层归档服务与 CLI 使用同一实现（导出→校验→导入往返）。
 *
 * 真正的命令行为由 `scripts/canvas-storage.mjs` 在 `npm run` 场景下使用；这里覆盖其
 * 安全边界与所用 API 的可用性。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CanvasArchiveService,
  InMemoryCanvasRepository,
  CanvasApplicationService } from "./index.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";

const CLI_PATH = fileURLToPath(new URL("../../../../../../scripts/canvas-storage.mjs", import.meta.url));

const NOW = "2026-09-23T00:00:00.000Z";

describe("CLI 安全边界（任务 8.6）", () => {
  const source = readFileSync(CLI_PATH, "utf8");

  it("提供 health / export / verify / import 四个子命令", () => {
    for (const command of ["health", "export", "verify", "import"]) {
      expect(source).toContain(`"${command}"`);
    }
  });

  it("不提供按画布删除 COS 对象的命令", () => {
    // 命令白名单里没有 delete / purge / gc 之类。
    expect(source).not.toMatch(/["'](delete|purge|gc|rm|destroy)["']/i);
    // 明确注释了为何不提供。
    expect(source).toContain("生命周期治理必须独立");
  });

  it("无本地二进制回退：不 import 文件媒体 adapter", () => {
    expect(source).not.toContain("GridFS");
    expect(source).not.toContain("BlobRepository");
  });
});

describe("CLI 所用归档往返（任务 8.6）", () => {
  it("export → verify → import 往返保持结构化数据", async () => {
    const source = new InMemoryCanvasRepository();
    const service = new CanvasApplicationService({ repository: source, now: () => NOW });
    await service.createCanvas({ canvasId: "canvas-a", title: "A" });

    const exporter = new CanvasArchiveService({ repository: source, now: () => NOW });
    const archive = await exporter.exportArchive();
    expect((await exporter.verifyArchive(archive)).ok).toBe(true);

    const target = new InMemoryCanvasRepository();
    const importer = new CanvasArchiveService({ repository: target, now: () => NOW });
    await importer.importArchive(archive);
    const imported = await target.getCanvas("canvas-a");
    expect(imported?.title).toBe("A");
    expect(imported?.document.schemaVersion).toBe("asset-canvas-v1");
  });

  it("InMemoryCanvasRepository 可被 CLI 用作 verify 的临时目标", async () => {
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-x", NOW));
    expect((await repository.listCanvases()).total).toBe(1);
  });
});
