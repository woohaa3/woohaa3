/**
 * 核心层 · storage 扩展点测试（设计稿：docs/diagrams/storage-extension-point.html）。
 *
 * 覆盖：注册表与重复注册、namespace 前缀、主存储每次调用现查（热切换）、expose 的三步解析顺序
 * （当前后端 presign → 对外后端复制后签名 → 明确报错）、就绪只看主存储、插件把设置读进路由，
 * 以及画布作用域相关的四条：路由（归属为远端→server、其余→primary）、scope 透传给后端、
 * 读时回填（旧对象首次访问时补传到路由后端，失败不影响读取）、replicate 幂等，
 * 以及「归属缺失时主存储未命中就是未命中」——读路径不跨后端起猜。
 */
import { describe, expect, it } from "vitest";
import {
  StorageExposeUnavailableError,
  StorageObjectNotFoundError,
  type HostStorageService,
  type StorageBackend,
  type StorageObject,
  type StorageScope
} from "@woohaa3/contracts";
import { createStorageRegistry, storagePlugin, type StorageSettings } from "./storage.js";

/** 后端被调用时实际收到的 scope（用来锁「core 必须把 scope 透传给后端」）。 */
type ScopeCall = { op: "head" | "get" | "openRead" | "put" | "delete" | "presign"; key: string; canvasId?: string };
type MemoryBackend = StorageBackend & {
  objects: Map<string, StorageObject>;
  presigns: string[];
  scopeCalls: ScopeCall[];
};

function memoryBackend(
  backendId: string,
  options: { presign?: boolean; delete?: boolean; canvasScoped?: boolean } = {}
): MemoryBackend {
  const objects = new Map<string, StorageObject>();
  const presigns: string[] = [];
  const scopeCalls: ScopeCall[] = [];
  const record = (op: ScopeCall["op"], key: string, scope?: StorageScope): void => {
    scopeCalls.push({ op, key, ...(scope ? { canvasId: scope.canvasId } : {}) });
  };
  return {
    backendId,
    label: backendId,
    ...(options.canvasScoped ? { canvasScoped: true } : {}),
    objects,
    presigns,
    scopeCalls,
    async head(key, scope) {
      record("head", key, scope);
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, ...(object.contentType ? { contentType: object.contentType } : {}) } : null;
    },
    async get(key, scope) {
      record("get", key, scope);
      const object = objects.get(key);
      if (!object) throw new StorageObjectNotFoundError(key);
      return object;
    },
    async openRead(key, range, scope) {
      record("openRead", key, scope);
      const object = objects.get(key);
      if (!object) throw new StorageObjectNotFoundError(key);
      const bytes = range ? object.bytes.subarray(range.start, range.end + 1) : object.bytes;
      return { bytes: (async function* () { yield bytes; })(), cancel() {} };
    },
    async put(key, bytes, contentType, scope) {
      record("put", key, scope);
      objects.set(key, { bytes, contentType });
    },
    ...(options.delete
      ? {
          async delete(key: string, scope?: StorageScope) {
            record("delete", key, scope);
            objects.delete(key);
          }
        }
      : {}),
    ...(options.presign
      ? {
          async presign(key: string, presignOptions?: { expiresSeconds?: number }, scope?: StorageScope) {
            record("presign", key, scope);
            presigns.push(key);
            return `https://${backendId}.invalid/${key}?expires=${presignOptions?.expiresSeconds ?? 900}`;
          }
        }
      : {})
  };
}

function settings(values: { primary?: string; expose?: string }): StorageSettings {
  return {
    primary: () => values.primary ?? "",
    expose: () => values.expose
  };
}

function registryWith(backends: readonly StorageBackend[], values: { primary?: string; expose?: string } = {}): HostStorageService {
  const registry = createStorageRegistry({ settings: settings(values) });
  for (const backend of backends) registry.register(backend);
  return registry;
}

describe("注册表", () => {
  it("注册、列举、解析与注销；重复 backendId 抛错", () => {
    const local = memoryBackend("local");
    const registry = createStorageRegistry({ settings: settings({}) });

    const unregister = registry.register(local);
    expect(registry.list().map((backend) => backend.backendId)).toEqual(["local"]);
    expect(registry.resolve("local")).toBe(local);
    expect(() => registry.register(memoryBackend("local"))).toThrow(/存储后端已注册：local/);

    unregister();
    expect(registry.list()).toEqual([]);
    // 注销函数幂等：重复调用不再报错。
    unregister();
  });

  it("主存储缺省是 local，expose 空值即没有对外后端", () => {
    const registry = registryWith([memoryBackend("local")]);
    expect(registry.primaryId()).toBe("local");
    expect(registry.exposeId()).toBeUndefined();
    expect(registry.readiness()).toEqual({ ready: true });
  });
});

describe("bucket(namespace)", () => {
  it("core 拼 namespace，后端只拿拼好的 key", async () => {
    const local = memoryBackend("local");
    const registry = registryWith([local], { primary: "local" });

    await registry.bucket("media").put("sha256-abc.png", Uint8Array.of(1, 2), "image/png");
    expect([...local.objects.keys()]).toEqual(["media/sha256-abc.png"]);
    expect(await registry.bucket("media").head("sha256-abc.png")).toEqual({ size: 2, contentType: "image/png" });
    expect((await registry.bucket("media").get("sha256-abc.png")).bytes.byteLength).toBe(2);
    expect(registry.bucket("media").backendId()).toBe("local");
  });

  it("不存在时 head 为 null、get 抛存储 not-found（后端语义原样透传）", async () => {
    const registry = registryWith([memoryBackend("local")], { primary: "local" });
    expect(await registry.bucket("media").head("gone.png")).toBeNull();
    await expect(registry.bucket("media").get("gone.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("主存储不支持删除时明确报错；支持时按 namespace 删除", async () => {
    const plain = memoryBackend("local");
    await expect(registryWith([plain], { primary: "local" }).bucket("media").delete!("a.png")).rejects.toThrow(/不支持删除/);

    const removing = memoryBackend("local");
    removing.delete = async (key) => {
      removing.objects.delete(key);
    };
    const registry = registryWith([removing], { primary: "local" });
    await registry.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    await registry.bucket("media").delete!("a.png");
    expect(removing.objects.has("media/a.png")).toBe(false);
  });

  it("主存储每次调用现查：切换设置后同一 bucket 立即走新后端", async () => {
    const values: { primary?: string; expose?: string } = { primary: "local" };
    const registry = createStorageRegistry({ settings: settings(values) });
    const local = memoryBackend("local");
    const second = memoryBackend("second");
    registry.register(local);
    registry.register(second);

    await registry.bucket("media").put("a.png", Uint8Array.of(1), "image/png");
    values.primary = "second";
    await registry.bucket("media").put("b.png", Uint8Array.of(2), "image/png");

    expect([...local.objects.keys()]).toEqual(["media/a.png"]);
    expect([...second.objects.keys()]).toEqual(["media/b.png"]);
    expect(registry.bucket("media").backendId()).toBe("second");
  });

  it("主存储未注册时给出可诊断错误（设置 storage.primary）", async () => {
    const registry = registryWith([], { primary: "cos" });
    expect(registry.readiness()).toEqual({ ready: false, reason: "主存储后端未注册：cos（设置 storage.primary）" });
    expect(registry.bucket("media").backendId()).toBe("cos");
    await expect(registry.bucket("media").head("a.png")).rejects.toThrow(/主存储后端未注册：cos/);
  });
});

describe("expose 解析顺序", () => {
  it("① 主存储有 presign 就直接签名，不碰对外后端", async () => {
    const local = memoryBackend("local", { presign: true });
    const cos = memoryBackend("cos", { presign: true });
    const registry = registryWith([local, cos], { primary: "local", expose: "cos" });
    const bucket = registry.bucket("media");
    await bucket.put("sha256-abc.png", Uint8Array.of(1), "image/png");

    expect(bucket.canExpose()).toBe(true);
    expect(await bucket.expose("sha256-abc.png", { expiresSeconds: 60 })).toBe(
      "https://local.invalid/media/sha256-abc.png?expires=60"
    );
    expect(cos.objects.size).toBe(0);
  });

  it("② 主存储没有 presign 时用对外后端：缺对象先从主存储复制（含 contentType）再签名", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos", { presign: true });
    const registry = registryWith([local, cos], { primary: "local", expose: "cos" });
    const bucket = registry.bucket("media");
    await bucket.put("sha256-abc.png", Uint8Array.of(1, 2, 3), "image/png");

    expect(await bucket.expose("sha256-abc.png")).toBe("https://cos.invalid/media/sha256-abc.png?expires=900");
    expect(cos.objects.get("media/sha256-abc.png")).toEqual({ bytes: Uint8Array.of(1, 2, 3), contentType: "image/png" });
    expect(cos.presigns).toEqual(["media/sha256-abc.png"]);
  });

  it("带 scope 时 expose 的复制来源也走读时回填（同步前生成的资产仍能签出地址）", async () => {
    const local = memoryBackend("local");
    const server = memoryBackend("server", { canvasScoped: true });
    const cos = memoryBackend("cos", { presign: true });
    local.objects.set("media/legacy.png", { bytes: Uint8Array.of(1, 2), contentType: "image/png" });
    const registry = createStorageRegistry({
      settings: settings({ primary: "local", expose: "cos" }),
      route: (namespace, canvasId) => namespace === "media" && canvasId === "synced"
    });
    registry.register(local);
    registry.register(server);
    registry.register(cos);

    const bucket = registry.bucket("media", { canvasId: "synced" });
    expect(await bucket.expose("legacy.png")).toBe("https://cos.invalid/media/legacy.png?expires=900");
    expect(cos.objects.get("media/legacy.png")).toEqual({ bytes: Uint8Array.of(1, 2), contentType: "image/png" });
    // 顺便把旧对象补到了路由后端，下次直接读它。
    expect(server.objects.get("media/legacy.png")).toEqual({ bytes: Uint8Array.of(1, 2), contentType: "image/png" });
  });

  it("② 对外后端已有同名对象时不再复制（key 内容寻址，复制幂等）", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos", { presign: true });
    await cos.put("media/sha256-abc.png", Uint8Array.of(9), "image/png");
    const registry = registryWith([local, cos], { primary: "local", expose: "cos" });

    expect(await registry.bucket("media").expose("sha256-abc.png")).toContain("cos.invalid");
    expect(cos.objects.get("media/sha256-abc.png")?.bytes).toEqual(Uint8Array.of(9));
  });

  it("③ 谁都不能签名时抛 StorageExposeUnavailableError（提示配置对外后端）", async () => {
    const registry = registryWith([memoryBackend("local")], { primary: "local" });
    const bucket = registry.bucket("media");
    await bucket.put("sha256-abc.png", Uint8Array.of(1), "image/png");

    expect(bucket.canExpose()).toBe(false);
    await expect(bucket.expose("sha256-abc.png")).rejects.toBeInstanceOf(StorageExposeUnavailableError);
    await expect(bucket.expose("sha256-abc.png")).rejects.toThrow(/storage.expose/);
  });

  it("对外后端未注册 / 本身没有 presign 都报可操作的错", async () => {
    const local = memoryBackend("local");
    const registry = registryWith([local], { primary: "local", expose: "cos" });
    await expect(registry.bucket("media").expose("a.png")).rejects.toThrow(/对外存储后端未注册：cos/);

    const plain = memoryBackend("cos");
    const withPlain = registryWith([local, plain], { primary: "local", expose: "cos" });
    await expect(withPlain.bucket("media").expose("a.png")).rejects.toThrow(/没有签名能力/);
    expect(withPlain.bucket("media").canExpose()).toBe(false);
  });

  it("主存储里没有对象时 expose 原样冒泡 not-found，不伪造地址", async () => {
    const registry = registryWith([memoryBackend("local"), memoryBackend("cos", { presign: true })], {
      primary: "local",
      expose: "cos"
    });
    await expect(registry.bucket("media").expose("gone.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });
});

describe("画布作用域路由", () => {
  function routedRegistry(values: { primary?: string; expose?: string } = {}): {
    registry: HostStorageService;
    local: MemoryBackend;
    server: MemoryBackend;
  } {
    const local = memoryBackend("local");
    // 承载者自己声明 canvasScoped：core 里没有任何后端 id。
    const server = memoryBackend("server", { canvasScoped: true });
    const registry = createStorageRegistry({
      settings: settings({ primary: "local", ...values }),
      // 只有 "synced" 画布同步到了远端；namespace 也参与路由判定。
      route: (namespace, canvasId) => namespace === "media" && canvasId === "synced"
    });
    registry.register(local);
    registry.register(server);
    return { registry, local, server };
  }

  it("route 命中已注册后端时读写都走它；未同步画布回落主存储", async () => {
    const { registry, local, server } = routedRegistry();

    const synced = registry.bucket("media", { canvasId: "synced" });
    expect(synced.backendId()).toBe("server");
    expect(synced.scope).toEqual({ canvasId: "synced" });
    await synced.put("a.png", Uint8Array.of(1, 2), "image/png");
    expect([...server.objects.keys()]).toEqual(["media/a.png"]);
    expect(local.objects.size).toBe(0);
    expect(await synced.head("a.png")).toEqual({ size: 2, contentType: "image/png" });

    const draft = registry.bucket("media", { canvasId: "draft" });
    expect(draft.backendId()).toBe("local");
    await draft.put("b.png", Uint8Array.of(3), "image/png");
    expect([...local.objects.keys()]).toEqual(["media/b.png"]);
    expect(server.objects.has("media/b.png")).toBe(false);
  });

  it("路由命中但没有任何后端声明 canvasScoped 时回落主存储（纯本地部署）", async () => {
    const local = memoryBackend("local");
    const registry = createStorageRegistry({
      settings: settings({ primary: "local" }),
      // 宿主说这张画布归远端，但没有后端声明能承载画布托管存储：不能靠猜后端 id。
      route: () => true
    });
    registry.register(local);

    const bucket = registry.bucket("media", { canvasId: "synced" });
    expect(bucket.backendId()).toBe("local");
    await bucket.put("a.png", Uint8Array.of(1), "image/png");
    expect([...local.objects.keys()]).toEqual(["media/a.png"]);
  });

  it("两个后端都声明 canvasScoped 时按注册顺序取第一个并记冲突告警", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const local = memoryBackend("local");
    const first = memoryBackend("server", { canvasScoped: true });
    const second = memoryBackend("server-backup", { canvasScoped: true });
    const registry = createStorageRegistry({
      settings: settings({ primary: "local" }),
      route: () => true,
      logger: (event) => logs.push(event)
    });
    registry.register(local);
    registry.register(first);
    registry.register(second);

    expect(registry.bucket("media", { canvasId: "synced" }).backendId()).toBe("server");
    await registry.bucket("media", { canvasId: "synced" }).put("a.png", Uint8Array.of(1), "image/png");
    expect(first.objects.has("media/a.png")).toBe(true);
    expect(second.objects.size).toBe(0);
    expect(logs.filter((event) => event.event === "storage-canvas-backend-conflict")).toHaveLength(1);
  });

  it("scope 原样透传给后端的每个方法（local / cos 忽略它，core 仍要传）", async () => {
    const local = memoryBackend("local", { delete: true });
    const registry = registryWith([local], { primary: "local" });
    local.objects.set("media/video.mp4", { bytes: Uint8Array.of(0, 1, 2, 3), contentType: "video/mp4" });

    const bucket = registry.bucket("media", { canvasId: "canvas-1" });
    await bucket.put("a.png", Uint8Array.of(1), "image/png");
    await bucket.head("video.mp4");
    await bucket.get("video.mp4");
    await bucket.openRead!("video.mp4", { start: 1, end: 2 });
    await bucket.delete!("a.png");

    expect(local.scopeCalls.map((call) => [call.op, call.canvasId])).toEqual([
      ["put", "canvas-1"],
      ["head", "canvas-1"],
      ["get", "canvas-1"],
      ["openRead", "canvas-1"],
      ["delete", "canvas-1"]
    ]);
  });
});

describe("读时回填（旧对象在路由后端的首次读取）", () => {
  function readThroughRegistry(options: { server?: Partial<MemoryBackend>; logger?: (event: Record<string, unknown>) => void } = {}) {
    const local = memoryBackend("local");
    const server = memoryBackend("server", { canvasScoped: true });
    Object.assign(server, options.server ?? {});
    local.objects.set("media/legacy.png", { bytes: Uint8Array.of(4, 5, 6), contentType: "image/png" });
    const registry = createStorageRegistry({
      settings: settings({ primary: "local" }),
      route: (namespace, canvasId) => namespace === "media" && canvasId === "synced",
      ...(options.logger ? { logger: options.logger } : {})
    });
    registry.register(local);
    registry.register(server);
    return { registry, local, server, bucket: registry.bucket("media", { canvasId: "synced" }) };
  }

  it("get 未命中路由后端时读主存储，并补传一份到路由后端", async () => {
    const { bucket, server } = readThroughRegistry();

    const object = await bucket.get("legacy.png");
    expect(Array.from(object.bytes)).toEqual([4, 5, 6]);
    expect(object.contentType).toBe("image/png");
    // 补传后路由后端已有同一对象：下一次读直接命中它，不再回源。
    expect(server.objects.get("media/legacy.png")).toEqual({ bytes: Uint8Array.of(4, 5, 6), contentType: "image/png" });
    const reads = server.scopeCalls.filter((call) => call.op === "get");
    expect(reads).toHaveLength(1);
    await bucket.get("legacy.png");
    expect(server.scopeCalls.filter((call) => call.op === "get")).toHaveLength(2);
  });

  it("head 命中主存储时同样触发补传", async () => {
    const { bucket, server } = readThroughRegistry();
    expect(await bucket.head("legacy.png")).toEqual({ size: 3, contentType: "image/png" });
    expect(server.objects.has("media/legacy.png")).toBe(true);
  });

  it("openRead 回落到主存储并补传，区间仍按调用方的范围裁剪", async () => {
    const { bucket, server } = readThroughRegistry();
    const stream = await bucket.openRead!("legacy.png", { start: 1, end: 2 });
    const chunks: number[] = [];
    for await (const chunk of stream.bytes) chunks.push(...chunk);
    expect(chunks).toEqual([5, 6]);
    expect(server.objects.has("media/legacy.png")).toBe(true);
  });

  it("补传失败只记日志，读取仍然成功（不把一次成功读变成错误）", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { bucket } = readThroughRegistry({
      server: {
        async put() {
          throw new Error("write down");
        }
      },
      logger: (event) => logs.push(event)
    });

    const object = await bucket.get("legacy.png");
    expect(Array.from(object.bytes)).toEqual([4, 5, 6]);
    expect(logs).toContainEqual({
      event: "storage-routed-backfill-failed",
      namespace: "media",
      backendId: "server",
      reason: "Error"
    });
  });

  it("路由后端与主存储都没有时保持 null / not-found", async () => {
    const { bucket } = readThroughRegistry();
    expect(await bucket.head("gone.png")).toBeNull();
    await expect(bucket.get("gone.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });
});

describe("replicate", () => {
  it("把主存储对象复制到目标后端；重复复制幂等返回 false", async () => {
    const local = memoryBackend("local");
    const server = memoryBackend("server");
    local.objects.set("media/a.png", { bytes: Uint8Array.of(7, 8), contentType: "image/png" });
    const registry = registryWith([local, server], { primary: "local" });

    expect(await registry.replicate("media", "a.png", { targetBackendId: "server" })).toBe(true);
    expect(server.objects.get("media/a.png")).toEqual({ bytes: Uint8Array.of(7, 8), contentType: "image/png" });
    expect(await registry.replicate("media", "a.png", { targetBackendId: "server" })).toBe(false);
  });

  it("来源与目标相同时直接返回 false（不读不写）", async () => {
    const local = memoryBackend("local");
    local.objects.set("media/a.png", { bytes: Uint8Array.of(1) });
    const registry = registryWith([local], { primary: "local" });

    expect(await registry.replicate("media", "a.png", { targetBackendId: "local" })).toBe(false);
    expect(local.scopeCalls).toEqual([]);
  });

  it("目标后端未注册时抛清晰错误", async () => {
    const registry = registryWith([memoryBackend("local")], { primary: "local" });
    await expect(registry.replicate("media", "a.png", { targetBackendId: "cos" })).rejects.toThrow(
      /存储后端未注册：cos（storage\.replicate 的目标后端）/
    );
  });

  it("带 scope 时来源默认取路由后端；显式 sourceBackendId 可指定主存储回填", async () => {
    const local = memoryBackend("local");
    const server = memoryBackend("server", { presign: true, canvasScoped: true });
    const cos = memoryBackend("cos", { presign: true });
    server.objects.set("media/synced.png", { bytes: Uint8Array.of(1), contentType: "image/png" });
    local.objects.set("media/legacy.png", { bytes: Uint8Array.of(2), contentType: "image/png" });
    const registry = createStorageRegistry({
      settings: settings({ primary: "local" }),
      route: (namespace, canvasId) => namespace === "media" && canvasId === "synced"
    });
    registry.register(local);
    registry.register(server);
    registry.register(cos);

    // 缺省来源 = 路由后端（画布已同步到 server）。
    expect(
      await registry.replicate("media", "synced.png", { targetBackendId: "cos", scope: { canvasId: "synced" } })
    ).toBe(true);
    expect(cos.objects.has("media/synced.png")).toBe(true);

    // 回填存量资产：显式指主存储，因为路由后端已不含旧对象。
    expect(
      await registry.replicate("media", "legacy.png", {
        targetBackendId: "server",
        scope: { canvasId: "synced" },
        sourceBackendId: "local"
      })
    ).toBe(true);
    expect(server.objects.has("media/legacy.png")).toBe(true);
  });
});

describe("storagePlugin", () => {
  it("把 storage.primary / storage.expose 读进路由，并把主存储就绪挂到 gateway", async () => {
    const values: Record<string, string> = { "storage.primary": "cos", "storage.expose": "" };
    const readiness: Array<() => unknown> = [];
    const provided: Record<string, unknown> = {};
    const ctx = {
      config: { get: (key: string) => values[key] },
      log: { scope: () => () => undefined },
      gateway: {
        readiness: (_order: number, check: () => unknown) => {
          readiness.push(check);
          return () => undefined;
        }
      },
      provide: (name: string, value: unknown) => {
        provided[name] = value;
      },
      effect: (callback: () => () => void) => {
        callback();
      }
    } as never;

    storagePlugin.apply(ctx, undefined as never);
    const storage = provided.storage as HostStorageService;
    expect(storage.primaryId()).toBe("cos");
    expect(storage.exposeId()).toBeUndefined();
    expect(readiness).toHaveLength(1);
    expect(await readiness[0]?.()).toEqual({ ready: false, reason: "主存储后端未注册：cos（设置 storage.primary）" });
  });
});


it("storagePlugin 按归属路由：归属为远端→server，其余→主存储（不看链路状态）", () => {
  const values: Record<string, string> = { "storage.primary": "local", "storage.expose": "" };
  const provided: Record<string, unknown> = {};
  const ctx = {
    config: { get: (key: string) => values[key] },
    log: { scope: () => () => undefined },
    gateway: { readiness: () => () => undefined },
    provide: (name: string, value: unknown) => {
      provided[name] = value;
    },
    effect: (callback: () => () => void) => {
      callback();
    },
    // canvas 在 storage 之后装载：这里模拟「懒取时已经就绪」。
    // 归属来自画布服务的持久记录；syncStateOf 在这里刻意恒为 undefined（没有链路），
    // 用它判断路由的实现在这条用例下会退化成主存储。
    get: (name: string) =>
      name === "canvas"
        ? {
            remoteCanvasIds: () => ["owned"],
            syncStateOf: () => undefined
          }
        : undefined
  } as never;

  storagePlugin.apply(ctx, undefined as never);
  const storage = provided.storage as HostStorageService;
  storage.register(memoryBackend("local"));
  storage.register(memoryBackend("server", { canvasScoped: true }));

  expect(storage.bucket("media", { canvasId: "owned" }).backendId()).toBe("server");
  expect(storage.bucket("media", { canvasId: "draft" }).backendId()).toBe("local");
});

it("流式读取传递 namespace 与区间，主存储热切换后使用新后端", async () => {
  const local = memoryBackend("local");
  const cos = memoryBackend("cos");
  const values = { primary: "local" };
  const registry = registryWith([local, cos], values);
  const bucket = registry.bucket("media");
  local.objects.set("media/video.mp4", { bytes: Uint8Array.of(0, 1, 2, 3) });
  const fallback = await bucket.openRead!("video.mp4", { start: 1, end: 2 });
  const chunks: number[] = [];
  for await (const chunk of fallback.bytes) chunks.push(...chunk);
  expect(chunks).toEqual([1, 2]);
  values.primary = "cos";
  let received: unknown;
  let cancelled = false;
  cos.openRead = async (key, range) => {
    received = { key, range };
    return { bytes: (async function* () { yield Uint8Array.of(7); })(), cancel() { cancelled = true; } };
  };
  const stream = await bucket.openRead!("video.mp4", { start: 10, end: 19 });
  expect(received).toEqual({ key: "media/video.mp4", range: { start: 10, end: 19 } });
  stream.cancel();
  expect(cancelled).toBe(true);
});

describe("归属决定后端（主存储未命中不再跨后端起猜）", () => {
  /**
   * 归属由画布服务维护（持久记录 + 运行时解析）。归属缺失时**只能**按主存储处理：
   * 多试一个后端会让读写对同一个对象给出不同答案（读得到、写不进），而且把归属的 bug
   * 掩盖成「有时能找到」的玄学。这条用例锁住「不兜底」。
   */
  function unownedRegistry() {
    const local = memoryBackend("local");
    const server = memoryBackend("server");
    server.objects.set("media/remote.png", { bytes: Uint8Array.of(7, 8, 9), contentType: "image/png" });
    const logs: Array<Record<string, unknown>> = [];
    const registry = createStorageRegistry({
      settings: settings({ primary: "local" }),
      // 路由未命中：模拟「这张画布没有远端归属记录」。
      route: () => false,
      logger: (event) => logs.push(event)
    });
    registry.register(local);
    registry.register(server);
    return { registry, local, server, logs, bucket: registry.bucket("media", { canvasId: "unowned" }) };
  }

  it("head/get/openRead 都按主存储未命中处理，托管后端零调用", async () => {
    const { bucket, local, server, logs } = unownedRegistry();

    expect(await bucket.head("remote.png")).toBeNull();
    await expect(bucket.get("remote.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(bucket.openRead!("remote.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);

    // 没有「先问一下远端」这种动作：既没有 RPC，也没有兜底日志。
    expect(server.scopeCalls).toEqual([]);
    expect(logs.filter((event) => String(event.event).startsWith("storage-remote-read-fallback"))).toEqual([]);
    expect(local.scopeCalls.map((call) => call.op)).toEqual(["head", "get", "openRead"]);
  });

  it("写入按归属走主存储，不会因为托管后端存在而改道", async () => {
    const { bucket, local, server } = unownedRegistry();
    await bucket.put("a.png", Uint8Array.of(1), "image/png");
    expect(local.objects.has("media/a.png")).toBe(true);
    expect(server.objects.has("media/a.png")).toBe(false);
  });
});
