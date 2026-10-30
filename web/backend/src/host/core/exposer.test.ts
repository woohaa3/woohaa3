/**
 * 核心层 · exposer 扩展点测试（地址投影）。
 *
 * 覆盖三步解析顺序：当前后端 presign 就地签 → 选中的提供者（requiresReplica 时先复制）→
 * 明确报错；以及隐式提供者（后端自带 presign 即是一个提供者）、注册提供者不复制字节的形态、
 * 画布作用域下的复制来源走读时回填、`available` 与真实能力一致、插件不挂就绪检查。
 */
import { describe, expect, it } from "vitest";
import {
  StorageExposeUnavailableError,
  StorageObjectNotFoundError,
  type HostStorageService,
  type StorageBackend,
  type StorageExposeInput,
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

function setup(values: { primary?: string; expose?: string } = {}, backends: readonly StorageBackend[] = []) {
  const storage: HostStorageService = createStorageRegistry({
    settings: { primary: () => values.primary ?? "local" }
  });
  for (const backend of backends) storage.register(backend);
  const logs: Array<Record<string, unknown>> = [];
  const exposer = createExposerRegistry({
    settings: { expose: () => values.expose },
    storage,
    logger: (event) => logs.push(event)
  });
  return { storage, exposer, logs };
}

describe("expose 解析顺序", () => {
  it("① 当前后端有 presign 就地签名，不碰对外后端", async () => {
    const local = memoryBackend("local", { presign: true });
    const cos = memoryBackend("cos", { presign: true });
    const { storage, exposer } = setup({ primary: "local", expose: "cos" }, [local, cos]);
    await storage.bucket("media").put("sha256-abc.png", Uint8Array.of(1), "image/png");

    expect(exposer.available("media")).toBe(true);
    expect(await exposer.expose({ namespace: "media", key: "sha256-abc.png", expiresSeconds: 60 })).toBe(
      "https://local.invalid/media/sha256-abc.png?expires=60"
    );
    expect(cos.objects.size).toBe(0);
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

  it("③ 谁都不能签时抛 StorageExposeUnavailableError（提示 storage.expose）", async () => {
    const { storage, exposer } = setup({ primary: "local" }, [memoryBackend("local")]);
    await storage.bucket("media").put("sha256-abc.png", Uint8Array.of(1), "image/png");

    expect(exposer.available("media")).toBe(false);
    await expect(exposer.expose({ namespace: "media", key: "sha256-abc.png" })).rejects.toBeInstanceOf(
      StorageExposeUnavailableError
    );
    await expect(exposer.expose({ namespace: "media", key: "sha256-abc.png" })).rejects.toThrow(/storage\.expose/);
  });

  it("对外后端未注册 / 本身没有 presign 都报可操作的错", async () => {
    const local = memoryBackend("local");
    const missing = setup({ primary: "local", expose: "cos" }, [local]);
    await expect(missing.exposer.expose({ namespace: "media", key: "a.png" })).rejects.toThrow(
      /对外存储后端未注册：cos/
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

    // 默认提供者仍然可用：坏值不再挡住「打开开关就生效」。
    exposer.register({ exposerId: "cos-public", requiresReplica: false, default: true, expose: async () => "https://u" });
    expect(exposer.selectedId()).toBe("cos-public");
  });
});

describe("内置默认提供者", () => {
  it("没有显式配置时用注册方声明的 default（开启开关即生效）", async () => {
    const local = memoryBackend("local");
    const { storage, exposer } = setup({ primary: "local" }, [local]);
    await storage.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    exposer.register({
      exposerId: "cos-public",
      requiresReplica: true,
      targetBackendId: "local",
      default: true,
      async expose(input) {
        return "https://public.invalid/" + input.namespace + "/" + input.key;
      }
    });

    expect(exposer.selectedId()).toBe("cos-public");
    expect(exposer.available("media")).toBe(true);
    expect(await exposer.expose({ namespace: "media", key: "a.png" })).toBe(
      "https://public.invalid/media/a.png"
    );
  });

  it("显式配置优先于 default", () => {
    const { exposer } = setup({ expose: "cos" }, [memoryBackend("cos", { presign: true })]);
    exposer.register({ exposerId: "cos-public", requiresReplica: false, default: true, expose: async () => "u" });
    expect(exposer.selectedId()).toBe("cos");
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
