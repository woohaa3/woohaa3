/**
 * 核心层 · exposer 扩展点测试（地址投影）。
 *
 * 覆盖三步解析顺序：当前后端 presign 就地签 → 选中的提供者（requiresReplica 时先复制）→
 * 明确报错；以及隐式提供者（后端自带 presign 即是一个提供者）、注册提供者不复制字节的形态、
 * 画布作用域下的复制来源走读时回填、`available` 与真实能力一致、插件不挂就绪检查。
 */
import { describe, expect, it, vi } from "vitest";
import {
  StorageExposeUnavailableError,
  StorageObjectNotFoundError,
  type HostStorageService,
  type StorageBackend,
  type StorageExposeInput,
  type StorageExposer,
  type StorageObject,
  type StorageScope
} from "@woohaa3/contracts";
import { createExposerRegistry, exposerPlugin } from "./exposer.js";
import { createStorageRegistry } from "./storage.js";

type MemoryBackend = StorageBackend & { objects: Map<string, StorageObject>; presigns: string[] };

function memoryBackend(
  backendId: string,
  options: { presign?: boolean; canvasScoped?: boolean } = {}
): MemoryBackend {
  const objects = new Map<string, StorageObject>();
  const presigns: string[] = [];
  return {
    backendId,
    label: backendId,
    ...(options.canvasScoped ? { canvasScoped: true } : {}),
    objects,
    presigns,
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, ...(object.contentType ? { contentType: object.contentType } : {}) } : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) throw new StorageObjectNotFoundError(key);
      return object;
    },
    async put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
    },
    ...(options.presign
      ? {
          async presign(key: string, presignOptions?: { expiresSeconds?: number }, _scope?: StorageScope) {
            presigns.push(key);
            return `https://${backendId}.invalid/${key}?expires=${presignOptions?.expiresSeconds ?? 900}`;
          }
        }
      : {})
  };
}

function setup(values: { primary?: string; expose?: string; order?: string[] } = {}, backends: readonly StorageBackend[] = []) {
  const storage: HostStorageService = createStorageRegistry({
    settings: { primary: () => values.primary ?? "local" }
  });
  for (const backend of backends) storage.register(backend);
  const logs: Array<Record<string, unknown>> = [];
  const exposer = createExposerRegistry({
    settings: { expose: () => values.expose, order: () => values.order ?? [] },
    storage,
    logger: (event) => logs.push(event)
  });
  return { storage, exposer, logs };
}

describe("expose 解析顺序", () => {
  it("① 全局显式来源优先于当前后端 presign（用户写下的选择压过现状）", async () => {
    const local = memoryBackend("local", { presign: true });
    const cos = memoryBackend("cos", { presign: true });
    const { storage, exposer } = setup({ primary: "local", expose: "cos" }, [local, cos]);
    await storage.bucket("media").put("sha256-abc.png", Uint8Array.of(1), "image/png");

    expect(exposer.available("media")).toBe(true);
    expect(await exposer.expose({ namespace: "media", key: "sha256-abc.png", expiresSeconds: 60 })).toBe(
      "https://cos.invalid/media/sha256-abc.png?expires=60"
    );
    expect(local.presigns).toEqual([]);
  });

  it("② 当前后端不能签时用选中的提供者：缺对象先复制（含 contentType）再签名", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos", { presign: true });
    const { storage, exposer } = setup({ primary: "local", expose: "cos" }, [local, cos]);
    await storage.bucket("media").put("sha256-abc.png", Uint8Array.of(1, 2, 3), "image/png");

    expect(await exposer.expose({ namespace: "media", key: "sha256-abc.png" })).toBe(
      "https://cos.invalid/media/sha256-abc.png?expires=900"
    );
    expect(cos.objects.get("media/sha256-abc.png")).toEqual({ bytes: Uint8Array.of(1, 2, 3), contentType: "image/png" });
    expect(cos.presigns).toEqual(["media/sha256-abc.png"]);
  });

  it("② 带 scope 时复制来源也走读时回填（同步前生成的资产仍能签出地址）", async () => {
    const local = memoryBackend("local");
    const server = memoryBackend("server", { canvasScoped: true });
    const cos = memoryBackend("cos", { presign: true });
    local.objects.set("media/legacy.png", { bytes: Uint8Array.of(1, 2), contentType: "image/png" });
    const storage = createStorageRegistry({
      settings: { primary: () => "local" },
      route: (namespace, canvasId) =>
        namespace === "media" && canvasId === "synced" ? { residency: "canvas-hosted" } : undefined
    });
    storage.register(local);
    storage.register(server);
    storage.register(cos);
    const exposer = createExposerRegistry({ settings: { expose: () => "cos" }, storage });

    expect(await exposer.expose({ namespace: "media", key: "legacy.png", scope: { canvasId: "synced" } })).toBe(
      "https://cos.invalid/media/legacy.png?expires=900"
    );
    expect(cos.objects.get("media/legacy.png")).toEqual({ bytes: Uint8Array.of(1, 2), contentType: "image/png" });
    // 顺便把旧对象补到了路由后端，下次直接读它。
    expect(server.objects.get("media/legacy.png")).toEqual({ bytes: Uint8Array.of(1, 2), contentType: "image/png" });
  });

  it("② 对外后端已有同名对象时不再复制（key 内容寻址，复制幂等）", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos", { presign: true });
    await cos.put("media/sha256-abc.png", Uint8Array.of(9), "image/png");
    const { exposer } = setup({ primary: "local", expose: "cos" }, [local, cos]);

    expect(await exposer.expose({ namespace: "media", key: "sha256-abc.png" })).toContain("cos.invalid");
    expect(cos.objects.get("media/sha256-abc.png")?.bytes).toEqual(Uint8Array.of(9));
  });

  it("③ 谁都不能签时抛 StorageExposeUnavailableError（提示 exposer.primary）", async () => {
    const { storage, exposer } = setup({ primary: "local" }, [memoryBackend("local")]);
    await storage.bucket("media").put("sha256-abc.png", Uint8Array.of(1), "image/png");

    expect(exposer.available("media")).toBe(false);
    await expect(exposer.expose({ namespace: "media", key: "sha256-abc.png" })).rejects.toBeInstanceOf(
      StorageExposeUnavailableError
    );
    await expect(exposer.expose({ namespace: "media", key: "sha256-abc.png" })).rejects.toThrow(/临时图床/);
  });

  it("对外后端未注册 / 本身没有 presign 都报可操作的错", async () => {
    const local = memoryBackend("local");
    const missing = setup({ primary: "local", expose: "cos" }, [local]);
    await expect(missing.exposer.expose({ namespace: "media", key: "a.png" })).rejects.toThrow(
      /临时图床提供者未注册：cos/
    );

    const plain = memoryBackend("cos");
    const withPlain = setup({ primary: "local", expose: "cos" }, [local, plain]);
    await expect(withPlain.exposer.expose({ namespace: "media", key: "a.png" })).rejects.toThrow(/没有签名能力/);
    expect(withPlain.exposer.available("media")).toBe(false);
  });

  it("当前后端里没有对象时原样冒泡 not-found，不伪造地址", async () => {
    const { exposer } = setup({ primary: "local", expose: "cos" }, [
      memoryBackend("local"),
      memoryBackend("cos", { presign: true })
    ]);
    await expect(exposer.expose({ namespace: "media", key: "gone.png" })).rejects.toBeInstanceOf(
      StorageObjectNotFoundError
    );
  });
});

describe("画布级地址覆盖", () => {
  it("覆盖优先于「当前后端就地签」，也优先于部署默认", async () => {
    const local = memoryBackend("local", { presign: true });
    const cos = memoryBackend("cos", { presign: true });
    const storage = createStorageRegistry({
      settings: { primary: () => "local" },
      // 这张画布显式指定了地址提供者：应压过 local 自己的 presign 与 storage.expose=cos。
      route: () => ({ residency: "primary", exposure: "ingress" })
    });
    storage.register(local);
    storage.register(cos);
    const exposer = createExposerRegistry({ settings: { expose: () => "cos" }, storage });
    exposer.register({
      exposerId: "ingress",
      requiresReplica: false,
      expose: async (input) => "https://ingress.invalid/" + input.namespace + "/" + input.key
    });
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");

    expect(exposer.available("media", { canvasId: "c1" })).toBe(true);
    expect(await exposer.expose({ namespace: "media", key: "a.png", scope: { canvasId: "c1" } })).toBe(
      "https://ingress.invalid/media/a.png"
    );
    expect(local.presigns).toEqual([]);
    expect(cos.presigns).toEqual([]);
  });

  it("覆盖为空串表示这张画布明确不对外", async () => {
    const local = memoryBackend("local", { presign: true });
    const storage = createStorageRegistry({
      settings: { primary: () => "local" },
      route: () => ({ residency: "primary", exposure: "" })
    });
    storage.register(local);
    const exposer = createExposerRegistry({ settings: { expose: () => "cos" }, storage });

    expect(exposer.available("media", { canvasId: "c1" })).toBe(false);
    await expect(
      exposer.expose({ namespace: "media", key: "a.png", scope: { canvasId: "c1" } })
    ).rejects.toBeInstanceOf(StorageExposeUnavailableError);
  });
});

describe("注册的提供者", () => {
  it("requiresReplica=false：不复制字节，提供者自己决定地址怎么可达", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local", expose: "ingress" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    const inputs: StorageExposeInput[] = [];
    exposer.register({
      exposerId: "ingress",
      label: "边缘节点",
      requiresReplica: false,
      async expose(input) {
        inputs.push(input);
        return `https://ingress.invalid/${input.namespace}/${input.key}`;
      }
    });

    expect(exposer.available("media")).toBe(true);
    expect(await exposer.expose({ namespace: "media", key: "a.png", scope: { canvasId: "c1" } })).toBe(
      "https://ingress.invalid/media/a.png"
    );
    expect(inputs).toEqual([{ namespace: "media", key: "a.png", scope: { canvasId: "c1" } }]);
    expect(local.objects.size).toBe(1);
  });

  it("requiresReplica=true：core 先把字节复制到 targetBackendId，再交给提供者签名", async () => {
    const local = memoryBackend("local");
    const archive = memoryBackend("archive", { presign: true });
    const { storage, exposer, logs } = setup({ primary: "local", expose: "cdn" }, [local, archive]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1, 2), "image/png");
    exposer.register({
      exposerId: "cdn",
      requiresReplica: true,
      targetBackendId: "archive",
      async expose(input) {
        return `https://cdn.invalid/${input.namespace}/${input.key}`;
      }
    });

    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://cdn.invalid/media/a.png");
    expect(archive.objects.get("media/a.png")?.bytes).toEqual(Uint8Array.of(1, 2));
    expect(logs.some((event) => event.event === "storage-expose-copy")).toBe(true);
  });
});

describe("无效的历史配置", () => {
  it("exposer.primary 指向不能签名的后端时按未设置处理，由内置默认提供者接管", async () => {
    // 拆分前这个键存的是存储后端 id，部署里可能还留着 `local`：它永远签不出地址。
    const values: Record<string, string> = { "exposer.primary": "local" };
    const provided: Record<string, unknown> = {};
    const logs: Array<Record<string, unknown>> = [];
    const storage = createStorageRegistry({ settings: { primary: () => "local" } });
    storage.register(memoryBackend("local"));
    const ctx = {
      config: { get: (key: string) => values[key] },
      log: { scope: () => (event: Record<string, unknown>) => logs.push(event) },
      storage,
      provide: (name: string, value: unknown) => {
        provided[name] = value;
      },
      effect: (callback: () => () => void) => {
        callback();
      }
    } as never;

    exposerPlugin.apply(ctx, undefined as never);
    const exposer = provided.exposer as ReturnType<typeof createExposerRegistry>;
    expect(exposer.selectedId()).toBeUndefined();
    expect(logs.some((event) => event.event === "exposer-primary-ignored" && event.value === "local")).toBe(true);

    // 坏值被忽略后就是「未选择」：注册了提供者也不会因此自动生效。
    exposer.register({ exposerId: "local-public", requiresReplica: false, expose: async () => "https://u" });
    expect(exposer.selectedId()).toBeUndefined();
  });
});

describe("没有默认提供者", () => {
  it("只注册不选择时不出地址：把素材交给第三方必须是显式选择", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    exposer.register({
      exposerId: "local-public",
      requiresReplica: false,
      async expose(input) {
        return "https://public.invalid/" + input.namespace + "/" + input.key;
      }
    });

    expect(exposer.selectedId()).toBeUndefined();
    expect(exposer.available("media")).toBe(false);
    await expect(exposer.expose({ namespace: "media", key: "a.png" })).rejects.toThrow(StorageExposeUnavailableError);
  });

  it("显式选中后才生效", async () => {
    const local = memoryBackend("local");
    const { exposer } = setup({ primary: "local", expose: "local-public" }, [local]);
    exposer.register({ exposerId: "local-public", requiresReplica: false, expose: async () => "https://public.invalid/a" });

    expect(exposer.selectedId()).toBe("local-public");
    expect(exposer.available("media")).toBe(true);
    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://public.invalid/a");
  });
});

describe("临时图床自动路由", () => {
  const providerExposer = (id: string, expose: StorageExposer["expose"], priority = 10, extra: Partial<StorageExposer> = {}): StorageExposer => ({
    exposerId: id,
    label: id,
    requiresReplica: false,
    temporaryHosting: { category: "provider", priority, ready: () => true },
    expose,
    ...extra
  });
  const builtinExposer = (id: string, expose: StorageExposer["expose"], extra: Partial<StorageExposer> = {}): StorageExposer => ({
    exposerId: id,
    label: id,
    requiresReplica: false,
    temporaryHosting: { category: "builtin", priority: 1000, ready: () => true },
    expose,
    ...extra
  });

  it("自动模式优先提供商（优先级→ID），内置只是后备，当前 presign 不抢占", async () => {
    const local = memoryBackend("local", { presign: true });
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    const calls: string[] = [];
    // 注册顺序与最终选择无关：先注册内置，再注册两个提供商。
    exposer.register(builtinExposer("builtin", async () => { calls.push("builtin"); return "https://builtin.invalid/a"; }));
    exposer.register(providerExposer("provider-b", async () => { calls.push("provider-b"); return "https://b.invalid/a"; }, 20));
    exposer.register(providerExposer("provider-a", async () => { calls.push("provider-a"); return "https://a.invalid/a"; }, 20));

    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://a.invalid/a");
    expect(calls).toEqual(["provider-a"]);
    expect(local.presigns).toEqual([]);

    const view = exposer.temporaryHosting();
    expect(view).toMatchObject({ mode: "auto", selectionSource: "auto", selectedId: "provider-a", error: null });
    expect(view.candidates.map(candidate => candidate.exposerId)).toEqual(["provider-a", "provider-b", "builtin"]);
    expect(view.candidates.find(candidate => candidate.selected)?.label).toBe("provider-a");
  });

  it("没有提供商时用内置；两者都不可用则如实不可用", async () => {
    const local = memoryBackend("local", { presign: true });
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid/a"));
    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://builtin.invalid/a");

    exposer.unregister("builtin");
    expect(exposer.temporaryHosting().error).toMatch(/没有可用的临时图床/);
    await expect(exposer.expose({ namespace: "media", key: "a.png" })).rejects.toBeInstanceOf(StorageExposeUnavailableError);
  });

  it("提供者注销后候选与快照立即更新，内置接管", async () => {
    const local = memoryBackend("local");
    const { exposer } = setup({ primary: "local" }, [local]);
    const remove = exposer.register(providerExposer("provider", async () => "https://provider.invalid", 1));
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid"));
    expect(exposer.temporaryHosting().candidates.map(candidate => candidate.exposerId)).toEqual(["provider", "builtin"]);
    remove();
    const view = exposer.temporaryHosting();
    expect(view.candidates.map(candidate => candidate.exposerId)).toEqual(["builtin"]);
    expect(view.selectedId).toBe("builtin");
    expect(exposer.available("media")).toBe(true);
  });

  it("请求约束会排除不支持的候选", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("clip.mp4", Uint8Array.of(1, 2, 3), "video/mp4");
    exposer.register(providerExposer("images-only", async () => "https://images.invalid", 1, {
      temporaryHosting: { category: "provider", priority: 1, constraints: { mediaKinds: ["image"] } }
    }));
    exposer.register(providerExposer("small", async () => "https://small.invalid", 2, {
      temporaryHosting: { category: "provider", priority: 2, constraints: { maxBytes: 2 } }
    }));
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid"));

    expect(exposer.temporaryHosting({ request: { mediaKind: "video", sizeBytes: 3 } }).candidates)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ exposerId: "images-only", available: false }),
        expect.objectContaining({ exposerId: "small", available: false })
      ]));
    expect(await exposer.expose({ namespace: "media", key: "clip.mp4" })).toBe("https://builtin.invalid");
  });

  it("无素材的配置查询保留受类型限制的提供商，实际请求仍按素材筛选", async () => {    const { storage, exposer } = setup({ primary: "local" }, [memoryBackend("local")]);
    const upload = vi.fn(async () => "https://images.invalid/a");
    exposer.register(providerExposer("images-only", upload, 1, {
      temporaryHosting: { category: "provider", priority: 1, constraints: { mediaKinds: ["image"] } }
    }));
    expect(exposer.temporaryHosting()).toMatchObject({ selectedId: "images-only", error: null });
    expect(exposer.temporaryHosting().candidates[0]).toMatchObject({ configured: true, available: true, selected: true });
    expect(exposer.available("media")).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(exposer.available("media", undefined, { mediaKind: "video" })).toBe(false);
    expect(exposer.temporaryHosting({ request: { mediaKind: "video" } }).selectedId).toBeNull();
    await storage.bucket("media").put("unknown", Uint8Array.of(1), "application/octet-stream");
    await expect(exposer.expose({ namespace: "media", key: "unknown" })).rejects.toBeInstanceOf(StorageExposeUnavailableError);
    expect(upload).not.toHaveBeenCalled();
    await storage.bucket("media").put("image.png", Uint8Array.of(1), "image/png");
    expect(await exposer.expose({ namespace: "media", key: "image.png" })).toBe("https://images.invalid/a");
  });

  it("明确未知窗口的来源可服务无窗口要求的请求，但被正数窗口要求排除", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    const upload = vi.fn(async () => "https://unknown.invalid/a");
    exposer.register(providerExposer("unknown-window", upload, 1, {
      temporaryHosting: { category: "provider", priority: 1, validitySeconds: null, ready: () => true }
    }));
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid/a"));

    // 不要求未来有效窗口时仍可用；不能被宿主缺省一天「补齐」成承诺。
    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://unknown.invalid/a");
    expect(upload).toHaveBeenCalledTimes(1);

    // 900 秒要求下候选被排除，自动路由走符合条件的内置来源。
    expect(exposer.available("media", undefined, { requiredValiditySeconds: 900 })).toBe(true);
    expect(exposer.temporaryHosting({ request: { requiredValiditySeconds: 900 } }).selectedId).toBe("builtin");
    expect(await exposer.expose({ namespace: "media", key: "a.png", request: { requiredValiditySeconds: 900 } }))
      .toBe("https://builtin.invalid/a");
    expect(upload).toHaveBeenCalledTimes(1);

    // 手动指定时明确失败，不静默改投。
    const manual = setup({ primary: "local", expose: "unknown-window" }, [local]);
    manual.exposer.register(providerExposer("unknown-window", async () => { throw new Error("无法满足 900 秒的有效窗口"); }, 1, {
      temporaryHosting: { category: "provider", priority: 1, validitySeconds: null, ready: () => true }
    }));
    await expect(manual.exposer.expose({ namespace: "media", key: "a.png", request: { requiredValiditySeconds: 900 } }))
      .rejects.toThrow(/900/);
  });

  it("同优先级按稳定 ID 字典序选择，与注册顺序无关", async () => {
    const { storage, exposer } = setup({ primary: "local" }, [memoryBackend("local")]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    const calls: string[] = [];
    exposer.register(providerExposer("sdpppx-temporary", async () => { calls.push("sdpppx"); return "https://sdpppx.invalid/a"; }, 10));
    exposer.register(providerExposer("runninghub-temporary", async () => { calls.push("runninghub"); return "https://rh.invalid/a"; }, 10));
    // 先注册 SDPPPX 也不改变结果：同优先级按 exposerId 字典序。
    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://rh.invalid/a");
    expect(calls).toEqual(["runninghub"]);
    expect(exposer.temporaryHosting().candidates.map(candidate => candidate.exposerId))
      .toEqual(["runninghub-temporary", "sdpppx-temporary"]);
  });

  it("能力中心投影来源自己的就绪说明，且不因此发起上传", async () => {
    const { exposer } = setup({ primary: "local" }, [memoryBackend("local")]);
    const upload = vi.fn(async () => "https://x.invalid/a");
    exposer.register(providerExposer("sdpppx-temporary", upload, 10, {
      temporaryHosting: {
        category: "provider",
        priority: 10,
        validitySeconds: null,
        ready: () => false,
        statusNote: () => "未登录 SDPPPX"
      }
    }));
    const view = exposer.temporaryHosting();
    expect(view.candidates[0]).toMatchObject({ configured: false, available: false, statusNote: "未登录 SDPPPX" });
    expect(view.error).toMatch(/没有可用的临时图床/);
    expect(upload).not.toHaveBeenCalled();
  });

  it("按列表顺序回退到下一个提供商，下一次请求从头解析", async () => {    const local = memoryBackend("local");
    const { storage, exposer, logs } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    let providerAttempts = 0;
    let otherAttempts = 0;
    exposer.register(providerExposer("first", async () => { providerAttempts += 1; throw new Error("401 unauthorized"); }, 1));
    exposer.register(providerExposer("second", async () => { otherAttempts += 1; return "https://second.invalid"; }, 2));
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid/a"));

    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://second.invalid");
    expect(providerAttempts).toBe(1);
    expect(otherAttempts).toBe(1);
    expect(logs.some(event => event.event === "exposer-temporary-fallback")).toBe(true);
    expect(exposer.temporaryHosting().lastFailure).toMatchObject({ exposerId: "first" });

    // 失败只影响本次请求：下一次独立请求仍先试提供商。
    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe("https://second.invalid");
    expect(providerAttempts).toBe(2);
  });

  it("提供商与内置回退都失败时报出两段真实原因", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    exposer.register(providerExposer("provider", async () => { throw new Error("provider 503"); }, 1));
    exposer.register(builtinExposer("builtin", async () => { throw new Error("bucket write denied"); }));
    await expect(exposer.expose({ namespace: "media", key: "a.png" })).rejects.toThrow(/provider 503[\s\S]*bucket write denied/);
    expect(exposer.temporaryHosting().lastFailure).toMatchObject({ exposerId: "builtin", message: "bucket write denied" });
  });

  it("手动指定失败不静默改投其他来源", async () => {
    const local = memoryBackend("local");
    const { exposer } = setup({ primary: "local", expose: "first" }, [local]);
    exposer.register(providerExposer("first", async () => { throw new Error("network down"); }, 1));
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid"));
    const view = exposer.temporaryHosting();
    expect(view).toMatchObject({ mode: "manual", selectionSource: "manual", selectedId: "first" });
    await expect(exposer.expose({ namespace: "media", key: "a.png" })).rejects.toThrow(/network down/);
  });

  it("取消、缺少素材或凭据 epoch 变化属于请求失效，不借回退绕过", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    exposer.register(builtinExposer("builtin", async () => "https://builtin.invalid"));
    let epoch = 1;
    let builtinCalls = 0;
    exposer.register(providerExposer("provider", async () => {
      epoch += 1; // 上传期间 Key 被替换
      return "https://provider.invalid";
    }, 1, {
      temporaryHosting: { category: "provider", priority: 1, ready: () => true, credentialEpoch: () => epoch }
    }));
    exposer.register(builtinExposer("counting", async () => { builtinCalls += 1; return "https://builtin.invalid/counting"; }));

    await expect(exposer.expose({ namespace: "media", key: "a.png" })).rejects.toMatchObject({ code: "STORAGE_EXPOSE_STALE" });
    expect(builtinCalls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(
      exposer.expose({ namespace: "media", key: "a.png", request: { signal: controller.signal } })
    ).rejects.toThrow(/取消/);
    expect(builtinCalls).toBe(0);
  });

  it("画布显式禁用不自动改投，画布显式来源压过全局自动", async () => {
    const local = memoryBackend("local");
    const disabled = createStorageRegistry({
      settings: { primary: () => "local" },
      route: () => ({ exposure: "" })
    });
    disabled.register(local);
    const disabledExposer = createExposerRegistry({ settings: { expose: () => undefined }, storage: disabled });
    disabledExposer.register(builtinExposer("builtin", async () => "https://builtin.invalid"));
    expect(disabledExposer.temporaryHosting({ scope: { canvasId: "c1" } }).mode).toBe("disabled");
    await expect(disabledExposer.expose({ namespace: "media", key: "a.png", scope: { canvasId: "c1" } }))
      .rejects.toThrow(/这张画布未启用临时图床/);
  });
});

describe("注册表", () => {
  it("重复 exposerId 抛错；注销后不再可选；隐式提供者按 backendId 暴露", () => {
    const cos = memoryBackend("cos", { presign: true });
    const { exposer } = setup({ expose: "cos" }, [cos]);
    expect(exposer.selectedId()).toBe("cos");
    expect(exposer.list().map((item) => item.exposerId)).toEqual(["cos"]);
    expect(exposer.resolve("cos")?.requiresReplica).toBe(true);

    const unregister = exposer.register({ exposerId: "x", requiresReplica: false, expose: async () => "u" });
    expect(() => exposer.register({ exposerId: "x", requiresReplica: false, expose: async () => "u" })).toThrow(
      /对外地址提供者已注册：x/
    );
    unregister();
    expect(exposer.resolve("x")).toBeUndefined();
  });
});

describe("exposerPlugin", () => {
  it("产品默认的 local-public 迁移为自动；用户显式值仍保持手动", () => {
    const create = (values: Record<string, string>, source: "default" | "file") => {
      const provided: Record<string, unknown> = {};
      const storage = createStorageRegistry({ settings: { primary: () => "local" } });
      const ctx = {
        config: {
          get: (key: string) => values[key],
          describe: () => [{ key: "exposer.primary", source }]
        },
        log: { scope: () => () => undefined },
        storage,
        provide: (name: string, value: unknown) => { provided[name] = value; },
        effect: (callback: () => () => void) => { callback(); }
      } as never;
      exposerPlugin.apply(ctx, undefined as never);
      return provided.exposer as ReturnType<typeof createExposerRegistry>;
    };

    const migrated = create({ "exposer.primary": "local-public" }, "default");
    expect(migrated.selectedId()).toBeUndefined();
    migrated.register({
      exposerId: "local-public", requiresReplica: false,
      temporaryHosting: { category: "builtin", ready: () => true },
      expose: async () => "https://builtin.invalid"
    });
    expect(migrated.temporaryHosting()).toMatchObject({ mode: "auto", selectionSource: "auto", selectedId: "local-public" });

    const explicit = create({ "exposer.primary": "local-public" }, "file");
    expect(explicit.selectedId()).toBe("local-public");
    expect(explicit.temporaryHosting().mode).toBe("manual");

    const legacy = { "exposer.primary": "auto", "storage.expose": "cos" };
    expect(create(legacy, "default").selectedId()).toBe("cos");
    const resetToAuto = create(legacy, "file");
    expect(resetToAuto.selectedId()).toBeUndefined();
    expect(resetToAuto.temporaryHosting().mode).toBe("auto");
  });

  it("旧键 storage.expose 的显式值继续作为手动选择（含 exposer.primary 为自动默认时）", () => {
    const provided: Record<string, unknown> = {};
    const storage = createStorageRegistry({ settings: { primary: () => "local" } });
    const ctx = {
      config: { get: (key: string) => ({ "exposer.primary": "auto", "storage.expose": "cos" } as Record<string, string>)[key], describe: () => [] },
      log: { scope: () => () => undefined },
      storage,
      provide: (name: string, value: unknown) => { provided[name] = value; },
      effect: (callback: () => () => void) => { callback(); }
    } as never;
    exposerPlugin.apply(ctx, undefined as never);
    expect((provided.exposer as { selectedId: () => string | undefined }).selectedId()).toBe("cos");
  });

  it("exposer.primary 优先于旧键 storage.expose", () => {
    const values: Record<string, string> = { "exposer.primary": "edge", "storage.expose": "cos" };
    const provided: Record<string, unknown> = {};
    const storage = createStorageRegistry({ settings: { primary: () => "local" } });
    const ctx = {
      config: { get: (key: string) => values[key] },
      log: { scope: () => () => undefined },
      storage,
      provide: (name: string, value: unknown) => {
        provided[name] = value;
      },
      effect: (callback: () => () => void) => {
        callback();
      }
    } as never;

    exposerPlugin.apply(ctx, undefined as never);
    expect((provided.exposer as { selectedId: () => string | undefined }).selectedId()).toBe("edge");
  });


  it("提供 ctx.exposer 并读取 storage.expose；不注册就绪检查", () => {
    const values: Record<string, string> = { "storage.expose": "cos" };
    const readiness: unknown[] = [];
    const provided: Record<string, unknown> = {};
    const storage = createStorageRegistry({ settings: { primary: () => "local" } });
    storage.register(memoryBackend("cos", { presign: true }));
    const ctx = {
      config: { get: (key: string) => values[key] },
      log: { scope: () => () => undefined },
      storage,
      gateway: { readiness: (...args: unknown[]) => { readiness.push(args); return () => undefined; } },
      provide: (name: string, value: unknown) => { provided[name] = value; },
      effect: (callback: () => () => void) => { callback(); }
    } as never;

    exposerPlugin.apply(ctx, undefined as never);
    expect(provided.exposer).toBeDefined();
    expect((provided.exposer as { selectedId: () => string | undefined }).selectedId()).toBe("cos");
    // 缺对外地址能力不该拖垮宿主：本插件从不登记就绪检查。
    expect(readiness).toHaveLength(0);
  });
});


it("声明 COS 图床后按配置展示、自动选择并先复制素材再签名，显式选择保持兼容", async () => {
  const cos = memoryBackend("cos", { presign: true });
  const values = { primary: "local", expose: undefined as string | undefined };
  const { storage, exposer } = setup(values, [memoryBackend("local"), cos]);
  const unregister = exposer.register({
    exposerId: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage",
    requiresReplica: true, targetBackendId: "cos",
    temporaryHosting: { category: "provider", priority: 100, validitySeconds: 900, ready: () => true },
    expose: input => cos.presign!(`${input.namespace}/${input.key}`, { expiresSeconds: input.expiresSeconds ?? 900 }, input.scope)
  });
  expect(exposer.list().filter(item => item.exposerId === "cos")).toHaveLength(1);
  expect(exposer.temporaryHosting()).toMatchObject({ selectedId: "cos", candidates: [
    { exposerId: "cos", configured: true, available: true, selected: true, ownerExtensionId: "cos-storage" }
  ] });
  await storage.bucket("media").put("reference.png", Uint8Array.of(1, 2, 3), "image/png");
  const input = { namespace: "media", key: "reference.png", expiresSeconds: 900 };
  expect(await exposer.expose(input)).toBe("https://cos.invalid/media/reference.png?expires=900");
  expect(cos.objects.get("media/reference.png")).toEqual({ bytes: Uint8Array.of(1, 2, 3), contentType: "image/png" });
  values.expose = "cos";
  expect(exposer.temporaryHosting()).toMatchObject({ mode: "manual", selectedId: "cos" });
  expect(await exposer.expose(input)).toBe("https://cos.invalid/media/reference.png?expires=900");
  unregister();
  expect(exposer.temporaryHosting().candidates).toEqual([]);
});


it("用户排序控制快照与调用优先级，热更新后立即生效并跳过不符合请求的来源", async () => {
  const values = { primary: "local", order: ["removed", "cos", "cos", "images-only"] };
  const { storage, exposer } = setup(values, [memoryBackend("local")]);
  await storage.bucket("media").put("clip.mp4", Uint8Array.of(1), "video/mp4");
  exposer.register({ exposerId: "cos", requiresReplica: false,
    temporaryHosting: { category: "provider", priority: 100, validitySeconds: 900 }, expose: async () => "https://cos.invalid" });
  exposer.register({ exposerId: "images-only", requiresReplica: false,
    temporaryHosting: { category: "provider", priority: 10, constraints: { mediaKinds: ["image"] } }, expose: async () => "https://images.invalid" });
  expect(exposer.temporaryHosting().candidates.map(item => item.exposerId)).toEqual(["cos", "images-only"]);
  expect(await exposer.expose({ namespace: "media", key: "clip.mp4" })).toBe("https://cos.invalid");
  values.order = ["images-only", "cos"];
  expect(exposer.temporaryHosting().selectedId).toBe("images-only");
  expect(exposer.temporaryHosting().candidates.map(item => item.exposerId)).toEqual(values.order);
  expect(await exposer.expose({ namespace: "media", key: "clip.mp4" })).toBe("https://cos.invalid");
  exposer.unregister("images-only");
  expect(exposer.temporaryHosting().selectedId).toBe("cos");
});
