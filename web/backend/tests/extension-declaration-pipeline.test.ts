/**
 * 扩展声明流水线端到端：**新增一个扩展只改扩展目录**。
 *
 * 断言宿主完全按扩展目录里的 `extension.json` 认识插件，而不是靠框架里的手写清单：
 * - `hostPlugin` 声明 → 插件树扩展层装载（设置面出现该插件卡片）；
 * - `metadata` 声明 → 站点/Provider 元数据；
 * - `modelRefresh`（插件对象声明）→ 设置面「可用模型」一节，路径由插件自己注册；
 * - `icon.asset` 声明 → 宿主注入 `/plugin-icons/<extensionId><ext>`；
 * - 公开路由由声明产生（不在这里写死路径清单）。
 *
 * 这条测试一旦需要「改宿主代码」才能通过，说明扩展纯粹性回退了。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendService, type BackendService } from "../src/composition.js";

const dirs: string[] = [];
let service: BackendService | null = null;

afterEach(async () => {
  await service?.close();
  service = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-extension-declarations-"));
  dirs.push(dir);
  return dir;
}

function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key: string) {
      return objects.get(key)!;
    },
    async exists(key: string) {
      return objects.has(key);
    },
    async stat(key: string) {
      const record = objects.get(key);
      if (!record) throw new Error("missing");
      return { size: record.bytes.byteLength, contentType: record.contentType };
    },
    async getHttpsUrl(key: string) {
      return `https://cos.invalid/${key}?sign=test`;
    }
  };
}

async function boot(): Promise<ReturnType<BackendService["modules"]>> {
  const dir = tempDir();
  service = await createBackendService({
    env: {
      WOOHAA3_CONFIG_FILE: path.join(dir, "woohaa.config.yml"),
      WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
      WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
    },
    logger: () => {},
    modelsConfig: { version: 1, models: [] },
    mediaStorage: memoryStorage() as never,
    enableYjsSync: false
  });
  // 可选 Provider 并发激活、不阻塞就绪（change: 2026-10-21-harden-extension-fault-isolation，D5）；
  // 断言注册表前等扩展层全部完成。
  await service.settled();
  return service.modules();
}

describe("扩展声明流水线", () => {
  it("Provider / 存储后端插件由 hostPlugin 声明装载，设置面按声明渲染", async () => {
    const { settings } = await boot();
    const plugins = settings.plugins();
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

    // 扩展层的插件全部来自扩展目录声明（不是宿主里的手写注册表）。
    for (const id of [
      "tokenhub-provider",
      "cephalon-provider",
      "replicate-provider",
      "fal-provider",
      "grsai-provider",
      "runninghub-provider",
      "ark-provider",
      "bailian-provider",
      "deepseek-provider",
      "local-storage",
      "cos-storage"
    ]) {
      expect(byId.has(id), `缺少声明装载的扩展插件：${id}`).toBe(true);
    }

    // 品牌图形：扩展包内资产 → 约定逻辑路径，由宿主注入。
    expect(byId.get("fal-provider")?.icon).toBe("/plugin-icons/fal-provider.png");
    expect(byId.get("local-storage")?.icon).toBe("storage");

    // 配置前即可说明扩展支持的输出类型，不依赖凭据或上游发现。
    for (const [id, types] of Object.entries({
      "tokenhub-provider": ["language", "image", "video"],
      "cephalon-provider": ["language", "image", "video"],
      "replicate-provider": ["language", "image", "video", "audio"],
      "fal-provider": ["language", "image", "video", "audio"],
      "grsai-provider": ["language", "image", "video"],
      "runninghub-provider": ["language", "image", "video"],
      "ark-provider": ["language", "image", "video"],
      "bailian-provider": ["image"],
      "deepseek-provider": ["language"],
    })) expect(byId.get(id)?.modelTypes, id).toEqual(types);

    // 模型刷新入口由插件自己声明（宿主不再有 Provider → 刷新路径的映射表）。
    // 模型刷新入口由插件自己声明（宿主不再有 Provider → 刷新路径的映射表）。
    const tokenhub = byId.get("tokenhub-provider");
    expect(tokenhub?.modelRefresh?.path).toBe("/api/providers/tokenhub/refresh");
    expect(tokenhub?.modelRefresh?.hint).toContain("TokenHub");
    // RunningHub 的清单来自官方公开 registry（RunningHub 没有按 key 查标准模型的接口），
    // 刷新只做增量；入口同样由插件声明，宿主不硬编码路径。
    expect(byId.get("runninghub-provider")?.modelRefresh?.path).toBe("/api/providers/runninghub/refresh");
    expect(byId.get("cephalon-provider")?.modelRefresh?.path).toBe("/api/providers/cephalon/refresh");
    expect(byId.get("deepseek-provider")?.modelRefresh?.path).toBe("/api/providers/deepseek/refresh");
  });

  it("声明装载的 Provider 真的注册进生成 registry", async () => {
    const { generation } = await boot();
    const ids = generation.list().map((provider) => provider.providerId);
    // 未配凭据的 Provider 仍要装载并注册（否则管理面看不到、也没法预填配置）；模型可用性另算。
    for (const id of ["tokenhub", "cephalon", "replicate", "fal", "grsai", "runninghub", "ark", "bailian", "deepseek"]) {
      expect(ids).toContain(id);
    }
  });
});
