import { describe, expect, it } from "vitest";
import { EXTENSION_HOST_METHODS, type ExtensionHostProviderRegistration } from "@woohaa3/contracts";
import type { PptaskProvider } from "@sdppp/pptask";
import { decodeLarge, encodeLarge } from "../rpc/index.js";
import { createProviderStub } from "./provider-stub.js";
import { createRpcPair } from "./rpc-pair.test-support.js";

function registration(overrides: Partial<ExtensionHostProviderRegistration> = {}): ExtensionHostProviderRegistration {
  return {
    providerId: "echo",
    available: true,
    models: [{ providerId: "echo", providerModelId: "echo-image", modelType: "image" }],
    members: [],
    modelInfo: { "image:echo-image": { methods: ["doGenerate"], maxImagesPerCall: 2 } },
    ...overrides
  } as ExtensionHostProviderRegistration;
}

describe("Provider 远程桩", () => {
  it("jobs.start 经宿主 job 引擎走到子进程 doGenerate；结果与大二进制往返", async () => {
    const { host, child } = createRpcPair();
    const calls: unknown[] = [];
    child.handle(EXTENSION_HOST_METHODS.providerModelCall, async (params) => {
      const decoded = await decodeLarge<Record<string, unknown>>(child, params);
      calls.push(decoded);
      // 1.5 MiB 图片：超过单帧一半，必须走大载荷流。
      return encodeLarge(child, { images: [new Uint8Array(1.5 * 1024 * 1024).fill(7)], warnings: [] });
    });
    const stub = createProviderStub({ extensionId: "fixture-echo", registration: registration(), target: () => host });
    const provider = stub.provider as PptaskProvider;
    const model = provider.imageModel("echo-image");
    expect(model.maxImagesPerCall).toBe(2);
    const handle = await provider.jobs.start({ model, input: { prompt: "cat", n: 1 } });
    const result = (await handle.wait()) as { images: Uint8Array[] };
    expect(result.images[0]!.byteLength).toBe(1.5 * 1024 * 1024);
    expect(result.images[0]![0]).toBe(7);
    expect(calls).toMatchObject([{ providerId: "echo", modelType: "image", modelId: "echo-image", method: "doGenerate", options: { prompt: "cat", n: 1 } }]);
  });

  it("AbortSignal 不过线，而是映射为 $/cancel：子进程 handler 的 signal 被 abort", async () => {
    const { host, child } = createRpcPair();
    let childAborted = false;
    child.handle(EXTENSION_HOST_METHODS.providerModelCall, (_params, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          childAborted = true;
          reject(Object.assign(new Error("aborted"), { code: "rpc-cancelled" }));
        });
      })
    );
    const stub = createProviderStub({ extensionId: "fixture-echo", registration: registration(), target: () => host });
    const model = (stub.provider as PptaskProvider).imageModel("echo-image");
    const controller = new AbortController();
    const pending = Promise.resolve(model.doGenerate({ prompt: "x", n: 1, abortSignal: controller.signal } as never));
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    await expect.poll(() => childAborted).toBe(true);
  });

  it("operation 模型：宿主引擎按 modelInfo 走 doStart/doStatus，并把 context 传给子进程", async () => {
    const { host, child } = createRpcPair();
    const seen: Array<{ method: string; context?: unknown }> = [];
    child.handle(EXTENSION_HOST_METHODS.providerModelCall, (params) => {
      const { method, context } = params as { method: string; context?: unknown };
      seen.push({ method, ...(context !== undefined ? { context } : {}) });
      if (method === "doStart") return { operation: { remoteId: "r-1" } };
      if (method === "doStatus") return { status: "completed", images: ["done"], warnings: [] };
      throw new Error(`unexpected ${method}`);
    });
    const stub = createProviderStub({
      extensionId: "fixture-echo",
      registration: registration({ modelInfo: { "image:echo-image": { methods: ["doStart", "doStatus", "doCancel"] } } }),
      target: () => host
    });
    const provider = stub.provider as PptaskProvider;
    const handle = await provider.jobs.start({ model: provider.imageModel("echo-image"), input: { prompt: "p", n: 1 } });
    await expect(handle.wait()).resolves.toMatchObject({ images: ["done"] });
    expect(seen[0]).toEqual({ method: "doStart", context: { jobId: handle.id } });
    expect(seen.some((entry) => entry.method === "doStatus")).toBe(true);
  });

  it("函数成员只为声明的装桩；describe 在宿主本地应答；prepareInput 走异步 RPC", async () => {
    const { host, child } = createRpcPair();
    child.handle(EXTENSION_HOST_METHODS.providerPrepareInput, (params) => ({ prepared: (params as { input: { prompt: string } }).input.prompt }));
    const stub = createProviderStub({
      extensionId: "fixture-echo",
      registration: registration({ members: ["prepareInput"] }),
      target: () => host
    });
    expect(stub.describe?.("echo-image")).toMatchObject({ modelType: "image" });
    expect(stub.describe?.("missing")).toBeUndefined();
    expect(stub.describeModel).toBeUndefined();
    expect(stub.uploadReference).toBeUndefined();
    await expect(
      stub.prepareInput!({ providerModelId: "echo-image", modelType: "image", prompt: "hi", parameters: {}, references: [] })
    ).resolves.toEqual({ prepared: "hi" });
  });

  it("实例不可用：桩立即以 extension-unavailable 失败；调用途中实例关闭以 extension-crashed 失败", async () => {
    let target: ReturnType<typeof createRpcPair>["host"] | null = null;
    const stub = createProviderStub({ extensionId: "fixture-echo", registration: registration(), target: () => target });
    const model = (stub.provider as PptaskProvider).imageModel("echo-image");
    await expect(model.doGenerate({ prompt: "x", n: 1 } as never)).rejects.toMatchObject({ code: "extension-unavailable" });
    const { host, child } = createRpcPair();
    target = host;
    child.handle(EXTENSION_HOST_METHODS.providerModelCall, () => new Promise(() => undefined));
    const pending = Promise.resolve(model.doGenerate({ prompt: "x", n: 1 } as never));
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.close("extension-crashed", "子进程退出");
    await expect(pending).rejects.toMatchObject({ code: "extension-crashed" });
  });
});
