/**
 * 原生核验适配器回归（change: 2026-10-16-integrate-photocraft-image-editing，任务 2.3；
 * change: 2026-10-21-extract-photocraft-subproject，任务 3.1 —— 改为可创建/释放的实例）。
 *
 * 验证适配器的进程纪律与实例语义，不需要真实 Rust 二进制：
 * - 以**参数数组**启动、字节只走 stdin、`--embedded-smart` 正确传递；
 * - 内容原因原样上抛、不回退；
 * - 超时/输出越界/启动失败按适配器原因处理并回退进程内核验；
 * - 并发上限真的排队（串行时耗时叠加）；
 * - 多实例互不影响并发与配置，`dispose()` 释放后不唤醒、不遗留排队者（design D5）。
 *
 * 子进程用 `test-support/fake-spawn.ts` 的进程内替身：迁移前那份「写 shebang 脚本再 chmod」
 * 的夹具在 Windows 上 `spawn` 会 ENOENT，而 `.cmd` 包装需要 shell（正是被测禁止的）。
 */
import { describe, expect, it } from "vitest";
import {
  NativeVerifierError,
  ProjectVerificationError,
  createNativeProjectVerifier,
  createProcessOnlyVerifier
} from "./index.js";
import { IMAGE_PROJECT_CONTENT_TYPE } from "@woohaa3/photocraft-protocol";
import { createFakeSpawn, fakeSummary } from "./test-support/fake-spawn.js";

const TEXT = new TextEncoder();

describe("原生核验适配器（实例化后行为不变）", () => {
  it("未配置时回退进程内有界核验，行为与之前一致", async () => {
    const instance = createProcessOnlyVerifier();
    expect(instance.configured()).toBe(false);
    await expect(
      instance.verifyForIngest(TEXT.encode("not a zip"), IMAGE_PROJECT_CONTENT_TYPE)
    ).rejects.toBeInstanceOf(ProjectVerificationError);
    instance.dispose();
  });

  it("拒绝非工程媒体类型", async () => {
    const instance = createProcessOnlyVerifier();
    await expect(instance.verifyForIngest(new Uint8Array([1]), "image/png")).rejects.toMatchObject({
      code: "unsupported-content-type"
    });
    instance.dispose();
  });

  it("用参数数组启动、字节只写 stdin，摘要按契约映射", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary({ generator: "fake:14" }) }) });
    const instance = createNativeProjectVerifier({ binaryPath: "photocraft-project-verify", spawnImpl: fake.spawnImpl });
    const bytes = TEXT.encode("OK-payload-1234");
    const summary = await instance.verify(bytes);
    expect(summary).toMatchObject({ formatVersion: 1, canvasWidth: 64, canvasHeight: 48, layerCount: 3 });
    expect(fake.calls).toHaveLength(1);
    // 直接断言「参数数组」形态：命令是单独的字符串，参数是数组而不是拼好的命令行。
    expect(fake.calls[0].command).toBe("photocraft-project-verify");
    expect(fake.calls[0].args).toEqual([]);
    // 字节只走 stdin，绝不出现在参数里。
    expect(fake.calls[0].bytes).toEqual(bytes);
    instance.dispose();
  });

  it("embedded-smart 以 --embedded-smart 参数传递", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary({ objectKinds: ["smart"] }) }) });
    const instance = createNativeProjectVerifier({ binaryPath: "/opt/verifier", spawnImpl: fake.spawnImpl });
    await instance.verify(TEXT.encode("SMART"), { embeddedSmart: true });
    expect(fake.calls[0].args).toEqual(["--embedded-smart"]);
    instance.dispose();
  });

  it("内容原因原样上抛，不回退", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: false, code: "too-many-layers", message: "层数超限" }) });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", spawnImpl: fake.spawnImpl });
    await expect(instance.verifyForIngest(TEXT.encode("REJECT"), IMAGE_PROJECT_CONTENT_TYPE)).rejects.toMatchObject({
      code: "too-many-layers"
    });
    instance.dispose();
  });

  it("超时按适配器原因处理并回退进程内核验", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary() }), delayMs: 5_000 });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", timeoutMs: 50, spawnImpl: fake.spawnImpl });
    await expect(instance.verify(TEXT.encode("SLOW"))).rejects.toMatchObject({ code: "native-verifier-timeout" });
    // ingest 入口：适配器超时 → 回退进程内核验（这里是无效字节，得到内容原因而不是适配器原因）。
    await expect(
      instance.verifyForIngest(TEXT.encode("SLOW"), IMAGE_PROJECT_CONTENT_TYPE)
    ).rejects.toBeInstanceOf(ProjectVerificationError);
    instance.dispose();
  });

  it("输出越界被截断并拒绝", async () => {
    const fake = createFakeSpawn({ floodBytes: 4 * 1024 * 1024 });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", maxOutputBytes: 64 * 1024, spawnImpl: fake.spawnImpl });
    await expect(instance.verify(TEXT.encode("HUGE"))).rejects.toMatchObject({
      code: "native-verifier-output-too-large"
    });
    instance.dispose();
  });

  it("启动失败按适配器原因处理", async () => {
    const fake = createFakeSpawn({ failToSpawn: "spawn verifier ENOENT" });
    const instance = createNativeProjectVerifier({ binaryPath: "missing", timeoutMs: 100, spawnImpl: fake.spawnImpl });
    await expect(instance.verify(TEXT.encode("OK"))).rejects.toBeInstanceOf(NativeVerifierError);
    await expect(instance.verifyForIngest(TEXT.encode("OK"), IMAGE_PROJECT_CONTENT_TYPE)).rejects.toBeInstanceOf(
      ProjectVerificationError
    );
    instance.dispose();
  });

  it("并发上限生效：串行时耗时叠加", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary() }), delayMs: 200 });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", timeoutMs: 5_000, maxConcurrent: 1, spawnImpl: fake.spawnImpl });
    const started = Date.now();
    await Promise.all([instance.verify(TEXT.encode("SLOW-1")), instance.verify(TEXT.encode("SLOW-2"))]);
    // 并发上限 1 时必须排队，两次合计不少于 380ms（若不排队约 200ms）。
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    instance.dispose();
  }, 10_000);

  it("并发上限大于 1 时允许并行", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary() }), delayMs: 200 });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", timeoutMs: 5_000, maxConcurrent: 2, spawnImpl: fake.spawnImpl });
    const started = Date.now();
    await Promise.all([instance.verify(TEXT.encode("SLOW-1")), instance.verify(TEXT.encode("SLOW-2"))]);
    expect(Date.now() - started).toBeLessThan(360);
    instance.dispose();
  }, 10_000);
});

describe("多实例隔离与释放（任务 3.1 / design D5）", () => {
  it("多实例各自持有配置：释放一个不影响另一个", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary({ generator: "fake:2" }) }) });
    const first = createNativeProjectVerifier({ binaryPath: "a", spawnImpl: fake.spawnImpl });
    const second = createNativeProjectVerifier({ binaryPath: "b", spawnImpl: fake.spawnImpl });
    expect(first.configured()).toBe(true);
    expect(second.configured()).toBe(true);
    first.dispose();
    expect(first.configured()).toBe(false);
    expect(second.configured()).toBe(true);
    expect((await second.verify(TEXT.encode("OK"))).generator).toBe("fake:2");
    second.dispose();
  });

  it("并发额度按实例计算，不共用全局计数器", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary() }), delayMs: 200 });
    const first = createNativeProjectVerifier({ binaryPath: "a", timeoutMs: 5_000, maxConcurrent: 1, spawnImpl: fake.spawnImpl });
    const second = createNativeProjectVerifier({ binaryPath: "b", timeoutMs: 5_000, maxConcurrent: 1, spawnImpl: fake.spawnImpl });
    const started = Date.now();
    // 两个实例各跑一次：若共用全局额度会串行（≥380ms），按实例计则并行（<360ms）。
    await Promise.all([first.verify(TEXT.encode("SLOW-1")), second.verify(TEXT.encode("SLOW-2"))]);
    expect(Date.now() - started).toBeLessThan(360);
    first.dispose();
    second.dispose();
  }, 10_000);

  it("释放后调用立即以不可用失败，不再起进程", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary() }) });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", spawnImpl: fake.spawnImpl });
    instance.dispose();
    await expect(instance.verify(TEXT.encode("OK"))).rejects.toMatchObject({ code: "native-verifier-unavailable" });
    expect(fake.calls).toHaveLength(0);
    // ingest 入口在实例释放后退回进程内路径，不报告「已启动」。
    await expect(instance.verifyForIngest(TEXT.encode("not a zip"), IMAGE_PROJECT_CONTENT_TYPE)).rejects.toBeInstanceOf(
      ProjectVerificationError
    );
  });

  it("排队中的调用在释放后被唤醒并失败，不永久挂起", async () => {
    const fake = createFakeSpawn({ output: JSON.stringify({ ok: true, summary: fakeSummary() }), delayMs: 200 });
    const instance = createNativeProjectVerifier({ binaryPath: "verifier", timeoutMs: 5_000, maxConcurrent: 1, spawnImpl: fake.spawnImpl });
    const firstRun = instance.verify(TEXT.encode("SLOW-1"));
    // 等第一个真正开始，让第二个进入排队。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = instance.verify(TEXT.encode("SLOW-2"));
    instance.dispose();
    await expect(queued).rejects.toMatchObject({ code: "native-verifier-unavailable" });
    await firstRun.catch(() => undefined);
  }, 10_000);

  it("embedded-smart 必须原生成功，不在原生失败时回退外层结构检查", async () => {
    const fake = createFakeSpawn({ failToSpawn: "spawn verifier ENOENT" });
    const instance = createNativeProjectVerifier({ binaryPath: "missing", timeoutMs: 100, spawnImpl: fake.spawnImpl });
    await expect(
      instance.verifyEmbeddedForIngest(TEXT.encode("not a zip"), IMAGE_PROJECT_CONTENT_TYPE)
    ).rejects.toBeInstanceOf(ProjectVerificationError);
    instance.dispose();
  });

  it("创建时拒绝空的工具路径", () => {
    expect(() => createNativeProjectVerifier({ binaryPath: "" })).toThrow("缺少原生核验工具路径");
    // 不存在的绝对路径在创建时允许（部署方可能在启动后才放置工具），首次调用才失败。
    expect(() => createNativeProjectVerifier({ binaryPath: "/opt/missing-verifier" })).not.toThrow();
  });
});
