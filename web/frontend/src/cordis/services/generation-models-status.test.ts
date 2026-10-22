/**
 * 生成模型状态 Service：快照里的 `catalogRevision` 透传与保留
 * （change: 2026-10-20-reserve-remote-generation-provider，任务 6.1/6.3）。
 *
 * 前端目录失效依赖这个值；旧宿主没有该字段时必须稳定退化为 -1，而不是 undefined。
 */
import { describe, expect, it, vi } from "vitest";
import { createGenerationModelsStatusService } from "./generation-models-status.js";
import type { GenerationModelsRemote } from "./generation-models-remote.js";

type SnapshotInput = { revision: number; catalogRevision?: number };

function modelsRemote(initial: SnapshotInput) {
  let current = initial;
  const fetchSnapshot = vi.fn<GenerationModelsRemote["fetchSnapshot"]>(async () => ({
    ok: true,
    snapshot: {
      revision: current.revision,
      initialized: true,
      models: [],
      ...(current.catalogRevision !== undefined ? { catalogRevision: current.catalogRevision } : {})
    }
  }));
  const writeConfig = vi.fn<GenerationModelsRemote["writeConfig"]>(async () => {
    current = { revision: current.revision + 1, catalogRevision: current.catalogRevision };
    return {
      ok: true,
      revision: current.revision,
      snapshot: {
        revision: current.revision,
        initialized: true,
        models: [],
        ...(current.catalogRevision !== undefined ? { catalogRevision: current.catalogRevision } : {})
      }
    };
  });
  return {
    remote: { fetchSnapshot, writeConfig } satisfies GenerationModelsRemote,
    fetchSnapshot,
    writeConfig
  };
}

describe("GenerationModelsStatusService catalogRevision", () => {
  it("刷新时读取宿主快照的 catalogRevision", async () => {
    const fake = modelsRemote({ revision: 3, catalogRevision: 7 });
    const service = createGenerationModelsStatusService({ remote: fake.remote });

    await service.refresh();

    expect(service.getSnapshot().revision).toBe(3);
    expect(service.getSnapshot().catalogRevision).toBe(7);
    service.dispose();
  });

  it("旧宿主缺字段时退化为 -1（无信号），不发布 undefined", async () => {
    const fake = modelsRemote({ revision: 3 });
    const service = createGenerationModelsStatusService({ remote: fake.remote });

    await service.refresh();

    expect(service.getSnapshot().catalogRevision).toBe(-1);
    service.dispose();
  });

  it("写响应不带目录修订时保留已读到的值（不回退）", async () => {
    const fake = modelsRemote({ revision: 3, catalogRevision: 7 });
    const service = createGenerationModelsStatusService({ remote: fake.remote });
    await service.refresh();

    // 策略写入成功但响应省略 catalogRevision（旧宿主/写路径不产出该字段）。
    fake.writeConfig.mockImplementationOnce(async () => ({
      ok: true as const,
      revision: 4,
      snapshot: { revision: 4, initialized: true, models: [] }
    }));
    const result = await service.setEnabled("litellm:gemini-4-argon", true);

    expect(result.ok).toBe(true);
    expect(service.getSnapshot().revision).toBe(4);
    expect(service.getSnapshot().catalogRevision).toBe(7);
    service.dispose();
  });

  it("写响应带更新的目录修订时采用新值", async () => {
    const fake = modelsRemote({ revision: 3, catalogRevision: 7 });
    const service = createGenerationModelsStatusService({ remote: fake.remote });
    await service.refresh();

    fake.writeConfig.mockImplementationOnce(async () => ({
      ok: true as const,
      revision: 4,
      snapshot: { revision: 4, initialized: true, models: [], catalogRevision: 9 }
    }));
    await service.setEnabled("litellm:gemini-4-argon", true);

    expect(service.getSnapshot().catalogRevision).toBe(9);
    service.dispose();
  });

  it("读取失败时保留已读到的目录修订", async () => {
    const fake = modelsRemote({ revision: 3, catalogRevision: 7 });
    const service = createGenerationModelsStatusService({ remote: fake.remote });
    await service.refresh();

    fake.fetchSnapshot.mockResolvedValueOnce({ ok: false as const, error: "网络不可达" });
    await service.refresh();

    expect(service.getSnapshot().error).toBe("网络不可达");
    expect(service.getSnapshot().catalogRevision).toBe(7);
    service.dispose();
  });
});
