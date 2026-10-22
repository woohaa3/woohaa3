/**
 * 阶段二端到端：受信任插件受理来源与受理版本
 * （change: improve-task-history-experience，任务 7.2/7.3/7.4）。
 *
 * 通过**真实内部 HTTP**（composition 的 handle）驱动插件任务 submit，再经浏览器只读 history
 * API 验证：来源投影为 plugin、extensionId 与固定受理版本可见、按来源/插件筛选、无画布任务
 * 呈现为正常来源而不是「缺少画布」。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTaskService, type TaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";

const MODELS: ModelsConfig = { version: 1, models: [] };
const TOKEN = "svc-token";
const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-plugin-history-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function recordingWorkerServer() {
  return {
    submitted: [] as Array<Record<string, unknown>>,
    server: {
      async submit(input: { key: string; input: unknown }) {
        return { created: true, record: { key: input.key, providerId: "litellm", status: "queued", attempt: 0 } };
      },
      async cancel() {},
      async status() {
        return null;
      },
      history: { subscribe: () => () => undefined },
      subscribe: () => () => undefined,
      stop() {},
      async drained() {},
      async close() {}
    }
  };
}

async function startService(storePath: string): Promise<{ service: TaskService; base: string; close: () => Promise<void> }> {
  const service = createTaskService({
    modelsConfig: MODELS,
    storePath,
    env: {
      LITELLM_API_KEY: "k",
      LITELLM_BASE_URL: "https://llm.example/v1",
      WOOHAA3_TASK_STORE_PATH: storePath
    },
    generationProviders: () => [{
      extensionId: "litellm-provider",
      providerId: "litellm",
      available: true,
      provider: {} as never,
      models: [{ providerId: "litellm", providerModelId: "gpt-4o-mini", modelType: "language" as const }],
      describeModel: async () => ({ providerId: "litellm", modelId: "gpt-4o-mini", modelType: "language", title: "GPT-4o mini" }) as never
    }],
    workerServer: recordingWorkerServer().server as never,
    serviceToken: TOKEN
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    service,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    }
  };
}

async function extensionSubmit(base: string, extensionId: string, key: string, configVersion: number) {
  const response = await fetch(`${base}/internal/v1/extensions/${extensionId}/tasks/${key}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify({
      extensionId,
      configVersion,
      modelType: "language",
      modelKey: "litellm:gpt-4o-mini",
      prompt: "插件非画布任务",
      parameters: {}
    })
  });
  return response.status;
}

describe("阶段二：插件来源与受理版本（7.2/7.3/7.4）", () => {
  it("插件任务投影为 plugin 来源、带 extensionId 与固定受理版本，且可通过来源筛选", async () => {
    const storePath = tempStore();
    const harness = await startService(storePath);
    try {
      expect(await extensionSubmit(harness.base, "sample-site", "plugin-run-1", 4)).toBe(202);

      // 浏览器只读 history API（loopback 授权）。
      const listResponse = await fetch(`${harness.base}/api/pptask/history?source=extension`);
      expect(listResponse.status).toBe(200);
      const page = (await listResponse.json()) as { items: Array<Record<string, unknown>> };
      const item = page.items.find((entry) => entry.taskKey === "plugin-run-1");
      expect(item).toBeDefined();
      expect(item!.source).toBe("extension");
      expect(item!.extensionId).toBe("sample-site");
      // 非画布任务：不合成 canvasId。
      expect(item!.canvasId).toBeUndefined();
      // 受理版本：extensionConfigVersion 来自受信任关联；缺失的模型版本不伪造。
      expect(item!.admission).toMatchObject({ extensionConfigVersion: 4 });
      expect((item!.admission as Record<string, unknown>).templateRevision).toBeUndefined();

      // extensionId 精确筛选。
      const byExtension = (await (await fetch(`${harness.base}/api/pptask/history?extensionId=sample-site`)).json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(byExtension.items.some((entry) => entry.taskKey === "plugin-run-1")).toBe(true);

      // 候选包含插件身份。
      const candidates = (await (await fetch(`${harness.base}/api/pptask/history/candidates`)).json()) as {
        plugins: Array<{ extensionId: string }>;
      };
      expect(candidates.plugins).toContainEqual({ extensionId: "sample-site" });

      // 详情暴露来源与受理版本。
      const detail = (await (await fetch(`${harness.base}/api/pptask/history/plugin-run-1`)).json()) as Record<string, unknown>;
      expect(detail.source).toBe("extension");
      expect(detail.extensionId).toBe("sample-site");
      expect(detail.admission).toMatchObject({ extensionConfigVersion: 4 });
    } finally {
      await harness.close();
    }
  });

  it("同一插件任务在配置更新后重查仍保持首次受理版本", async () => {
    const storePath = tempStore();
    const harness = await startService(storePath);
    try {
      expect(await extensionSubmit(harness.base, "sample-site", "plugin-run-2", 4)).toBe(202);
      // 同一 key 再次提交（模拟重启/补偿）携带不同 configVersion：已受理版本不被覆盖。
      await extensionSubmit(harness.base, "sample-site", "plugin-run-2", 9).catch(() => undefined);
      const detail = (await (await fetch(`${harness.base}/api/pptask/history/plugin-run-2`)).json()) as {
        admission?: { extensionConfigVersion?: number };
      };
      expect(detail.admission?.extensionConfigVersion).toBe(4);
    } finally {
      await harness.close();
    }
  });
});
