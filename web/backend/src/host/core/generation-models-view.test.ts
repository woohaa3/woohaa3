import { describe, expect, it } from "vitest";
import { buildGenerationModelsSnapshot, projectGenerationModelViews, readTaskCatalogRevision } from "./generation.js";

const provider = {
  extensionId: "litellm-provider",
  providerId: "litellm",
  available: true,
  provider: {},
  models: [
    { providerId: "litellm", providerModelId: "gpt-image-2", modelType: "image" as const, title: "gpt-image-2" },
    { providerId: "litellm", providerModelId: "gemini-2.5-flash", modelType: "language" as const, title: "gemini-2.5-flash" }
  ]
};

describe("projectGenerationModelViews", () => {
  it("shows every registered model as enabled before policy is initialized", () => {
    const views = projectGenerationModelViews([provider], { initialized: false, revision: 0, models: [] });
    expect(views.map((model) => [model.modelKey, model.modelType, model.enabled])).toEqual([
      ["litellm:gpt-image-2", "image", true],
      ["litellm:gemini-2.5-flash", "language", true]
    ]);
  });

  it("keeps policy choices and shows newly discovered models as disabled", () => {
    const views = projectGenerationModelViews([provider], {
      initialized: true,
      revision: 3,
      models: [{ modelKey: "litellm:gpt-image-2", enabled: true, isDefault: true }]
    });
    expect(views).toEqual([
      expect.objectContaining({ modelKey: "litellm:gpt-image-2", modelType: "image", enabled: true, isDefault: true, executable: true }),
      expect.objectContaining({ modelKey: "litellm:gemini-2.5-flash", modelType: "language", enabled: false, executable: true })
    ]);
  });

  // 已注册但没配凭据的 Provider（例如没填 API Key 的 RunningHub）：模型仍要列出来（能预填策略），
  // 但必须标成不可执行——它们的模型进不了 catalog，画布上选不到。
  it("marks models of an unavailable provider as not executable while still listing them", () => {
    const unavailable = { ...provider, available: false, provider: undefined };
    const views = projectGenerationModelViews([unavailable], { initialized: false, revision: 0, models: [] });
    expect(views.map((model) => [model.modelKey, model.enabled, model.executable])).toEqual([
      ["litellm:gpt-image-2", true, false],
      ["litellm:gemini-2.5-flash", true, false]
    ]);
  });

  it("marks policy-only models (provider no longer registered) as not executable", () => {
    const views = projectGenerationModelViews([], {
      initialized: true,
      revision: 2,
      models: [{ modelKey: "runninghub:api/seedream-v5-pro", enabled: true, isDefault: false }]
    });
    expect(views).toEqual([
      expect.objectContaining({ modelKey: "runninghub:api/seedream-v5-pro", enabled: true, executable: false })
    ]);
  });

  it("公开快照透出任务目录修订（catalogRevision）", () => {
    const snapshot = buildGenerationModelsSnapshot(
      { get: () => ({ catalogRevision: () => 9 }) } as never,
      [provider],
      { initialized: false, revision: 2, models: [] }
    );
    expect(snapshot).toMatchObject({ revision: 2, initialized: false, catalogRevision: 9 });
    expect(snapshot.models.map((model) => model.modelKey)).toEqual([
      "litellm:gpt-image-2",
      "litellm:gemini-2.5-flash"
    ]);
  });

  // 设置页按 extensionId 把远端 Provider 的模型归到「服务端接入」卡片（它没有 providers.<id> 配置段，
  // 按 providerId 匹配不到）。模型是否可用仍由本机策略的 enabled 决定。
  it("每个注册表模型带 extensionId", () => {
    const views = projectGenerationModelViews([provider], { initialized: true, revision: 3, models: [] });
    expect(views.map((model) => [model.modelKey, model.extensionId])).toEqual([
      ["litellm:gpt-image-2", "litellm-provider"],
      ["litellm:gemini-2.5-flash", "litellm-provider"]
    ]);
  });

  it("远端 Provider 的模型透出 extensionId=remote-server，enabled 仍是本机策略事实", () => {
    const remote = {
      extensionId: "remote-server",
      providerId: "remote-server",
      available: true,
      provider: {},
      models: [
        { providerId: "remote-server", providerModelId: "auto", modelType: "language" as const, title: "auto" },
        { providerId: "remote-server", providerModelId: "claude-fable-5", modelType: "language" as const, title: "claude-fable-5" }
      ]
    };
    const views = projectGenerationModelViews([remote], { initialized: true, revision: 5, models: [] });
    expect(views).toEqual([
      expect.objectContaining({
        modelKey: "remote-server:auto",
        providerId: "remote-server",
        extensionId: "remote-server",
        executable: true,
        // 策略里没有这一行就是未启用：与其它 Provider 相同，需在设置页启用后才进目录。
        enabled: false
      }),
      expect.objectContaining({ modelKey: "remote-server:claude-fable-5", enabled: false })
    ]);
  });

  it("策略历史行（Provider 已卸载）没有 extensionId", () => {
    const views = projectGenerationModelViews([], {
      initialized: true,
      revision: 2,
      models: [{ modelKey: "runninghub:api/seedream-v5-pro", enabled: true, isDefault: false }]
    });
    expect(views).toHaveLength(1);
    expect("extensionId" in views[0]!).toBe(false);
  });

  it("drops stale model ids of a provider that is still registered", () => {
    const ark = {
      extensionId: "ark-provider",
      providerId: "ark",
      available: true,
      provider: {},
      models: [
        { providerId: "ark", providerModelId: "doubao-seedance-2-0-260128", modelType: "video" as const, title: "Seedance 2.0", executable: false }
      ]
    };
    const views = projectGenerationModelViews([ark], {
      initialized: true,
      revision: 4,
      models: [
        { modelKey: "ark:seedance2_0", title: "Seedance 2.0", enabled: true, isDefault: false },
        { modelKey: "ark:doubao-seedance-2-0-260128", enabled: true, isDefault: false }
      ]
    });
    expect(views.map((model) => [model.modelKey, model.modelType, model.executable])).toEqual([
      ["ark:doubao-seedance-2-0-260128", "video", false]
    ]);
  });
});

describe("readTaskCatalogRevision（懒取 task 服务，不入 inject 以防成环）", () => {
  it("读取 Task Service 的目录修订", () => {
    const requested: string[] = [];
    const ctx = {
      get: (name: string) => {
        requested.push(name);
        return name === "task" ? { catalogRevision: () => 12 } : undefined;
      }
    };
    expect(readTaskCatalogRevision(ctx as never)).toBe(12);
    expect(requested).toEqual(["task"]);
  });

  it("task 服务尚未装载 / 旧版没有该方法 / 读取抛错时回 0", () => {
    expect(readTaskCatalogRevision({ get: () => undefined } as never)).toBe(0);
    expect(readTaskCatalogRevision({ get: () => ({}) } as never)).toBe(0);
    expect(readTaskCatalogRevision({ get: () => { throw new Error("boom"); } } as never)).toBe(0);
  });
});
