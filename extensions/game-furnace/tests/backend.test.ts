/**
 * 游戏炼丹炉后端控制器测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 6/7/8；按 integration 新架构重实现）。
 *
 * 用确定性的进程内 facade 替身验证：准入校验、真实 language Task 提交、完整结果解码与不可变
 * 构建保存/原子关联/自动激活、旧输入候选、畸形/越界资源拒绝，以及短期只读预览会话与 CSP。
 * 真实模型调用不在此替身内，须由 notes/acceptance.md 的真实凭据验收覆盖。
 *
 * 与源分支测试的差异（架构重实现）：新架构扩展后端无画布容器 facade，项目改为内容寻址
 * （`saveProject`/`openProject` 经 Media），因此 harness 不再注入 `containers`，而是用同一
 * durable Media 替身模拟跨重启恢复（存储键持久、内存快照按需重开）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApplicationExtensionMediaFacade,
  ApplicationExtensionTaskFacade
} from "@woohaa3/contracts";
import { createGameFurnaceBackend } from "../src/backend.js";
import { createGamePreviewHost } from "../src/preview/backend/host.js";
import { computeInputHash, reduceGameFurnace, projectIdFor, type GameFurnaceState, MAX_INLINE_TEXT_CHARS, MAX_INLINE_SNAPSHOT_CHARS } from "../src/shared.js";
import { planGameFurnaceDrop } from "../src/authoring/shared/collection.js";
import { gameFurnaceArchiveDefinition } from "../src/archive.js";
import { pendingFinalizations } from "../src/authoring/backend/finalize-worker.js";
import { resourceDependencyPaths, decodeSourcePackage } from "../src/state/shared/package.js";

const VALID_HTML = `<!doctype html><html><head></head><body><canvas id="g"></canvas>
<img src="assets/res-hero.png"><script>let score=0;function loop(){score++;requestAnimationFrame(loop)}loop();</script></body></html>`;

const CANVAS_ID = "canvas-1";
const NODE_ID = "n1";
const PROJECT_KEY = `${CANVAS_ID}:${NODE_ID}`;

const temporaryRoots: string[] = [];

it("同/跨画布打开剪贴板引用创建独立项目，重写清单，保留旧素材且不复制 Task", async () => {
  const h = await newHarness();
  const generated = await h.controller.generate(h.request());
  h.taskStatus.set(String(generated.workerTaskKey), "succeeded");
  h.taskResults.set(String(generated.workerTaskKey), VALID_HTML);
  await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(generated.generationId) });
  await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [{ type: "resources.remove", resourceIds: ["res-hero"] }] as never });
  h.taskStatus.set("source-pending-task", "queued");
  await h.setState({ ...h.state, latestGenerationId: "pending", generations: [...h.state.generations, {
    generationId: "pending", workerTaskKey: "source-pending-task", inputHash: "pending-input", admittedAt: "now", workId: "source-work"
  }] });
  const originalKey = h.projectStorageKey;
  const originalState = structuredClone(h.state);
  const originalBytes = h.storedBytes.get(originalKey)!.slice();
  for (const canvasId of [CANVAS_ID, "other-canvas"]) {
    const input = { canvasId, nodeId: `copy-${canvasId}`, projectStorageKey: originalKey };
    const opened = await h.controller.openProject(input);
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
    const copy = opened.state as GameFurnaceState;
    expect(copy.projectId).toBe(projectIdFor(canvasId, input.nodeId));
    expect(copy.projectId).not.toBe(originalState.projectId);
    expect(copy.activeBuildId).not.toBe(originalState.activeBuildId);
    expect(copy.latestGenerationId).toBeUndefined();
    expect(copy.generations.every(generation => generation.executionDetached && !generation.workId)).toBe(true);
    expect(copy.generations[0].workerTaskKey).not.toBe(originalState.generations[0].workerTaskKey);
    expect(pendingFinalizations(copy)).toEqual([]);
    const pendingCopy = copy.generations.find(generation => !generation.candidateBuildId)!;
    expect(pendingCopy.disposition).toBe("discarded");
    expect((await h.controller.finalize({ canvasId, nodeId: input.nodeId, generationId: pendingCopy.generationId })).state).toBe("cancelled");
    await h.controller.cancel({ canvasId, nodeId: input.nodeId, generationId: pendingCopy.generationId });
    expect(copy.builds[0].resources[0].resourceId).not.toBe("res-hero");
    const pkg = decodeSourcePackage(h.storedBytes.get(copy.builds[0].sourceAssetId)!);
    expect(pkg.manifest.buildId).toBe(copy.activeBuildId);
    expect(pkg.manifest.resources[0].resourceId).toBe(copy.builds[0].resources[0].resourceId);
    const preview = await h.controller.openPreview({ canvasId, nodeId: input.nodeId, buildId: copy.activeBuildId! });
    expect(preview.ok).toBe(true);
    expect(h.controller.previewFetch(String(preview.sessionId), "assets/res-hero.png")!.bytes).toEqual(h.storedBytes.get("sha256-a"));
    const copiedKey = h.controller.runtime()!.projects.get(`${canvasId}:${input.nodeId}`)!.projectStorageKey;
    const reopened = await h.controller.openProject({ ...input, projectStorageKey: copiedKey });
    expect((reopened.state as GameFurnaceState).activeBuildId).toBe(copy.activeBuildId);
    await h.controller.detachTarget(input);
    expect(h.cancelCalls).toEqual([]);
  }
  expect(h.state).toEqual(originalState);
  expect(h.storedBytes.get(originalKey)).toEqual(originalBytes);
  h.controller.dispose();
});

it("复制清单存储失败不发布半成品项目、不改变原节点或取消原 Task", async () => {
  const h = await newHarness();
  const submitted = await h.controller.submitGame({ ...h.request(), requestId: "source", html: VALID_HTML });
  expect(submitted.ok).toBe(true);
  const original = structuredClone(h.state);
  const key = h.projectStorageKey;
  h.failWritesAfter(h.writeCalls.length + 1);
  const copy = await h.controller.openProject({ canvasId: CANVAS_ID, nodeId: "failed-copy", projectStorageKey: key });
  expect(copy.ok).toBe(false);
  expect(h.controller.runtime()!.projects.has(`${CANVAS_ID}:failed-copy`)).toBe(false);
  expect(h.state).toEqual(original);
  expect(h.cancelCalls).toEqual([]);
  h.controller.dispose();
});

it("显式保存其它目标的项目也脱离原执行；无 owner 的旧确定性项目仍可复制", async () => {
  const h = await newHarness();
  const generated = await h.controller.generate(h.request());
  const source = structuredClone(h.state);
  const saved = await h.controller.saveProject({ canvasId: CANVAS_ID, nodeId: "imported", state: source });
  expect(saved.ok).toBe(true);
  const copied = h.controller.runtime()!.projects.get(`${CANVAS_ID}:imported`)!.state;
  expect(copied.projectId).toBe(projectIdFor(CANVAS_ID, "imported"));
  expect(copied.generations[0]).toMatchObject({ executionDetached: true, disposition: "discarded" });
  expect(copied.generations[0].workerTaskKey).not.toBe(generated.workerTaskKey);
  expect(h.state).toEqual(source);
  const legacy = { ...source, projectId: projectIdFor(CANVAS_ID, NODE_ID) };
  delete legacy.projectOwner;
  const bytes = new TextEncoder().encode(JSON.stringify(legacy));
  const raw = await h.controller.runtime()!.services.media.resources!.write({ bytes, contentType: "application/json" });
  const opened = await h.controller.openProject({ canvasId: "new-canvas", nodeId: NODE_ID, projectStorageKey: raw.storageKey });
  expect(opened).toMatchObject({ ok: true, state: { projectId: projectIdFor("new-canvas", NODE_ID), projectOwner: { canvasId: "new-canvas", nodeId: NODE_ID } } });
  expect((opened.state as GameFurnaceState).generations[0].executionDetached).toBe(true);
  expect(h.cancelCalls).toEqual([]);
  h.controller.dispose();
});
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function projectHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "furnace-prepared-test-")); temporaryRoots.push(root);
  const h = harness(initialState(), root); await h.ready; return h;
}

it("MCP只准备目录和复制大素材；Agent产物登记后跨重启独立，预览不含base64", async () => {
  const h = await projectHarness();
  h.storedBytes.set("sha256-a", new Uint8Array(2 * 1024 * 1024).fill(7));
  const prepared = await h.controller.prepareProject(h.request());
  expect(prepared).toMatchObject({ ok: true, projectId: expect.any(String) });
  const directory = String(prepared.projectDirectory);
  expect(await readFile(path.join(directory, "public/assets/res-hero.png"))).toHaveLength(2 * 1024 * 1024);
  const input = { ...h.request(), requestId: "agent-site-v2", projectId: String(prepared.projectId) };
  expect(await h.controller.submitGame(input)).toMatchObject({ ok: false, code: "project-publish-failed" }); // 宿主不会自行构建
  await writeFile(path.join(directory, "src/main.js"), "// Agent自己的代码");
  expect(await h.controller.prepareProject(h.request())).toMatchObject({ ok: true, projectId: prepared.projectId });
  expect(await readFile(path.join(directory, "src/main.js"), "utf8")).toBe("// Agent自己的代码");
  // 模拟Agent构建产物；业务代码不执行构建。
  await cp(path.join(directory, "public"), path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "dist/index.html"), '<!doctype html><html><body><img src="assets/res-hero.png"><script type="module" src="./game.js"></script></body></html>');
  await writeFile(path.join(directory, "dist/game.js"), 'document.body.dataset.playing="yes";');
  await writeFile(path.join(directory, "dist/game.css"), 'body{margin:0}');
  const built = await h.controller.submitGame(input);
  expect(built, JSON.stringify(built)).toMatchObject({ ok: true, state: "succeeded" });
  const source = decodeSourcePackage(h.storedBytes.get(h.state.builds[0]!.sourceAssetId)!);
  expect(source.site?.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "assets/res-hero.png", size: 2 * 1024 * 1024 }), expect.objectContaining({ path: "index.html" })]));
  expect(source.site?.files.some(file => file.path.endsWith(".js"))).toBe(true);
  h.storedBytes.delete("sha256-a"); await rm(directory, { recursive: true, force: true });
  await h.restart();
  const opened = await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: String(built.buildId) });
  expect(opened).toMatchObject({ ok: true, format: "vite-static-site", entryUrl: expect.stringContaining("/site/") });
  expect(JSON.stringify(opened).length).toBeLessThan(4096);
  expect(h.controller.previewFetch(String(opened.sessionId), "assets/res-hero.png")!.bytes).toHaveLength(2 * 1024 * 1024);
  expect(h.state.builds).toHaveLength(1); h.controller.dispose();
});

it("登记产物拒绝其它节点目录、目录越界、符号链接和缺失素材", async () => {
  const h = await projectHarness();
  const prepared = await h.controller.prepareProject(h.request());
  const directory = String(prepared.projectDirectory);
  await mkdir(path.join(directory, "dist"));
  await writeFile(path.join(directory, "dist/index.html"), '<html><script src="./game.js"></script></html>');
  const input = { ...h.request(), requestId: "publish", projectId: String(prepared.projectId) };
  expect(await h.controller.submitGame({ ...input, projectId: "other-project" })).toMatchObject({ ok: false });
  expect(await h.controller.submitGame({ ...input, outputDirectory: "../outside" })).toMatchObject({ ok: false });
  await symlink(path.join(directory, "package.json"), path.join(directory, "dist/game.js"));
  expect(await h.controller.submitGame(input)).toMatchObject({ ok: false });
  await rm(path.join(directory, "dist/game.js")); await writeFile(path.join(directory, "dist/game.js"), "let score=0;");
  expect(await h.controller.submitGame(input)).toMatchObject({ ok: false }); // 缺素材
  expect(h.state.activeBuildId).toBeUndefined(); h.controller.dispose();
});

function initialState(overrides: Partial<GameFurnaceState> = {}): GameFurnaceState {
  return {
    projectId: "gf-proj",
    resources: [
      {
        resourceId: "res-hero",
        kind: "image",
        name: "主角",
        category: "图片",
        description: "主角图",
        payload: { kind: "asset", assetIds: ["asset-1"] },
        metadata: { mime: "image/png", storageKey: "sha256-a", previewAssetId: "asset-1" }
      }
    ],
    requirements: { name: "跳跃游戏", description: "跳跃并收集金币", modelKey: "gpt-language" },
    generations: [],
    builds: [],
    ...overrides
  };
}

function harness(initial: GameFurnaceState = initialState(), workspaceRoot?: string) {
  // durable 媒体存储：跨 restart 保留（模拟 Media 服务的持久性）。
  const storedBytes = new Map<string, Uint8Array>();
  storedBytes.set("sha256-a", new Uint8Array([1, 2, 3, 4]));
  let writeCounter = 0;
  const writeCalls: Array<{ contentType: string; length: number }> = [];
  let failWrites = false;
  let failWritesAfter = Number.POSITIVE_INFINITY;
  const media: ApplicationExtensionMediaFacade = {
    resources: {
      async read(storageKey: string) {
        const bytes = storedBytes.get(storageKey);
        if (!bytes) throw new Error("not found");
        return { bytes, contentType: "application/json" };
      },
      async write({ bytes, contentType }: { bytes: Uint8Array; contentType: string }) {
        if (failWrites || writeCalls.length >= failWritesAfter) throw new Error("media store failure");
        const storageKey = `sha256-w${writeCounter++}`;
        storedBytes.set(storageKey, bytes);
        writeCalls.push({ contentType, length: bytes.length });
        return { storageKey, contentType, size: bytes.length, checksum: `sum-${storageKey}` };
      }
    },
    async stat(storageKey: string) {
      const bytes = storedBytes.get(storageKey);
      return bytes ? { exists: true, contentType: "application/json", size: bytes.length } : { exists: false };
    }
  };

  // durable Task 服务替身：跨 restart 保留（真 Task 会持久化 key）。
  const taskStatus = new Map<string, string>();
  const taskResults = new Map<string, string>();
  const submitCalls: Array<Record<string, unknown>> = [];
  const cancelCalls: string[] = [];
  const tasks: ApplicationExtensionTaskFacade = {
    async submit(input: Record<string, unknown>) {
      submitCalls.push(input);
      const key = String(input.workerTaskKey);
      if (!taskStatus.has(key)) taskStatus.set(key, "queued");
      return { ok: true, workerTaskKey: key, reused: false, state: taskStatus.get(key)! };
    },
    async status(workerTaskKey: string) { const state = taskStatus.get(workerTaskKey); return state ? { workerTaskKey, state } : null; },
    async cancel(workerTaskKey: string) { cancelCalls.push(workerTaskKey); return { workerTaskKey, state: "cancelled" }; },
    async result(workerTaskKey: string) { const text = taskResults.get(workerTaskKey); return text === undefined ? null : { workerTaskKey, state: "succeeded", result: { mediaKind: "text", text } } as never; }
  } as unknown as ApplicationExtensionTaskFacade;

  let admitted = true;
  const controller = createGameFurnaceBackend();
  let lastState: GameFurnaceState = initial;
  const install = (finalizeIntervalMs = 3_600_000) => controller.install({
    workspaceRoot,
    services: { tasks, media },
    work: () => (admitted ? { ok: true, workId: "work-12345678", configVersion: 3 } : { ok: false, reason: "disabled" }),
    preview: createGamePreviewHost(),
    logger: () => undefined,
    finalizeIntervalMs
  });
  install();

  const save = async (state: GameFurnaceState) => {
    lastState = state;
    const saved = await controller.saveProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, state });
    return saved;
  };

  // 打开初始项目（写第一份 envelope）。
  const ready = save(initial);

  return {
    controller,
    ready,
    taskStatus,
    taskResults,
    submitCalls,
    cancelCalls,
    storedBytes,
    writeCalls,
    setAdmitted(value: boolean) { admitted = value; },
    setFailWrites(value: boolean) { failWrites = value; },
    failWritesAfter(count: number) { failWritesAfter = count; },
    /** 立即处理一次在途生成（任务 6.9）；生产由后台 worker 自动轮询。 */
    flushFinalizations() { return controller.flushFinalizations(); },
    /** 当前 canonical 项目状态（从控制器内存快照读取，与 saveProject/applyOperations 同步）。 */
    get state(): GameFurnaceState {
      return controller.runtime()?.projects.get(PROJECT_KEY)?.state ?? lastState;
    },
    /** 当前项目 envelope 的稳定 storageKey（任务 4.4 乐观并发基线）。 */
    get projectStorageKey(): string {
      return controller.runtime()!.projects.get(PROJECT_KEY)!.projectStorageKey;
    },
    /** 覆盖项目状态（模拟远端/前端更新）。 */
    async setState(next: GameFurnaceState) { await save(next); },
    /** 删除项目（模拟节点被删除）。 */
    deleteProject() { controller.runtime()!.projects.delete(PROJECT_KEY); },
    currentHash(): string { return computeInputHash(this.state); },
    request() { return { canvasId: CANVAS_ID, nodeId: NODE_ID, expectedInputHash: this.currentHash(), supportedInputs: [{ mediaKinds: ["image", "video", "audio"], mediaTypes: [] }] }; },
    /**
     * 模拟后端重启：沿用同一 durable 状态重新装配控制器，并按**节点保存的最新 storageKey**
     * 恢复项目（节点只保存稳定关联）。
     */
    async restart() {
      const latestStorageKey = controller.runtime()!.projects.get(PROJECT_KEY)!.projectStorageKey;
      controller.dispose();
      install();
      await controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: latestStorageKey });
    },
    /**
     * 模拟**浏览器刷新**：canonical 节点只保存前端写回的关联键（`nodeStorageKey`）；刷新后工作区用
     * 该键 `openProject`。后台 worker 无前端、无画布写能力，不能更新这个键。
     */
    async refreshFromNode(nodeStorageKey: string) {
      controller.dispose();
      install();
      return controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: nodeStorageKey });
    }
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function newHarness(initial?: GameFurnaceState): Promise<Harness> {
  const h = harness(initial);
  await h.ready;
  return h;
}

describe("generate 准入与真实 language Task（任务 6.2/6.3/6.4/6.5）", () => {
  it("expectedInputHash 冲突拒绝，不提交任务", async () => {
    const h = await newHarness();
    const result = await h.controller.generate({ canvasId: CANVAS_ID, nodeId: NODE_ID, expectedInputHash: "stale" });
    expect(result).toMatchObject({ ok: false, code: "content-conflict" });
    expect(h.submitCalls).toHaveLength(0);
  });

  it("名称/描述必填缺失时拒绝", async () => {
    const h = await newHarness(initialState({ requirements: { name: "", description: "", modelKey: "m" } }));
    expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "invalid-requirements" });
  });

  it("无可用 language 模型时拒绝并给出配置入口语义", async () => {
    const h = await newHarness(initialState({ requirements: { name: "n", description: "d" } }));
    expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "language-model-unavailable" });
  });

  it("插件停用（work 拒绝）时拒绝新准入", async () => {
    const h = await newHarness();
    h.setAdmitted(false);
    expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "work-not-ready" });
  });

  it("成功：以 language 模型提交、链接 generation、返回 inputHash 与 workerTaskKey", async () => {
    const h = await newHarness();
    const result = await h.controller.generate(h.request());
    expect(result.ok).toBe(true);
    expect(result.state).toBe("queued");
    // 只提交一次 language 任务。
    expect(h.submitCalls).toHaveLength(1);
    expect(h.submitCalls[0]).toMatchObject({ modelType: "language", modelKey: "gpt-language" });
    // generation 已链接到 canonical 内容，且 state 不含大段 HTML。
    const state = h.state;
    expect(state.generations).toHaveLength(1);
    expect(state.latestGenerationId).toBe(state.generations[0]!.generationId);
    expect(JSON.stringify(state)).not.toContain("<html");
    expect(computeInputHash(state)).toBe(result.inputHash);
  });
});

describe("输入编译的多模态能力与 canonical 输入锁定（任务 6.4/6.6）", () => {
  it("catalog 未声明参考输入：不提交任何多模态 binding，素材仍以描述/路径进入 prompt", async () => {
    const h = await newHarness();
    const noInputs = await h.controller.generate({ canvasId: CANVAS_ID, nodeId: NODE_ID, expectedInputHash: h.currentHash() });
    expect(noInputs.ok).toBe(true);
    expect(h.submitCalls[0]!.inputs).toEqual([]);
    expect(String(h.submitCalls[0]!.prompt)).toContain("引用路径：assets/res-hero.png");
  });

  it("catalog 声明图片参考且 MIME 匹配：只提交受支持的图片 binding（任务 6.6）", async () => {
    const h = await newHarness();
    const granted = await h.controller.generate({
      canvasId: CANVAS_ID, nodeId: NODE_ID, expectedInputHash: h.currentHash(),
      supportedInputs: [{ mediaKinds: ["image"], mediaTypes: ["image/png"] }]
    });
    expect(granted.ok).toBe(true);
    expect(h.submitCalls[0]!.inputs).toEqual([
      { assetId: "asset-1", role: "image", storageKey: "sha256-a", mediaType: "image/png", mediaKind: "image" }
    ]);
  });

  it("catalog 声明图片但 MIME 不匹配：不提交该素材的 binding（任务 6.6）", async () => {
    const h = await newHarness();
    const mismatched = await h.controller.generate({
      canvasId: CANVAS_ID, nodeId: NODE_ID, expectedInputHash: h.currentHash(),
      supportedInputs: [{ mediaKinds: ["image"], mediaTypes: ["image/webp"] }]
    });
    expect(mismatched.ok).toBe(true);
    expect(h.submitCalls[0]!.inputs).toEqual([]);
  });

  it("生成时把已确认输入写为 canonical 输入 manifest：含 model/策略/素材 checksum/冻结键/路径（任务 6.4）", async () => {
    const h = await newHarness();
    const result = await h.controller.generate({ canvasId: CANVAS_ID, nodeId: NODE_ID, expectedInputHash: h.currentHash() });
    expect(result.ok).toBe(true);
    const generation = h.state.generations[0]!;
    expect(typeof generation.inputManifestAssetId).toBe("string");
    const manifest = JSON.parse(new TextDecoder().decode(h.storedBytes.get(generation.inputManifestAssetId!)!)) as {
      inputHash: string; modelKey: string; policyVersion: string;
      resources: { resourceId: string; contentHash: string; path: string; storageKey?: string; mime?: string }[];
    };
    expect(manifest.modelKey).toBe("gpt-language");
    expect(manifest.inputHash).toBe(result.inputHash);
    expect(manifest.policyVersion).toBeTruthy();
    expect(manifest.resources).toEqual([
      expect.objectContaining({ resourceId: "res-hero", path: "assets/res-hero.png", storageKey: "sha256-a", mime: "image/png", contentHash: expect.any(String) })
    ]);
  });
});

describe("未知项目版本原文保留（任务 7.9）", () => {
  it("openProject 读到更高 schemaVersion 时拒绝解释并保留原文（不缓存、不覆盖）", async () => {
    const h = await newHarness();
    // 写入一个未来版本号的 envelope（含无法被 v1 识别的字段）。
    const future = { schemaVersion: 99, projectId: "gf-future", futureOnly: { keep: "verbatim" } };
    const bytes = new TextEncoder().encode(JSON.stringify(future));
    const stored = await h.controller.runtime()!.services.media.resources!.write({ bytes, contentType: "application/json" });
    const opened = await h.controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: stored.storageKey });
    expect(opened).toMatchObject({ ok: false, code: "unsupported-version", preserved: true, version: 99 });
    // 原文仍然可读且逐字节不变。
    const raw = await h.controller.runtime()!.services.media.resources!.read(stored.storageKey);
    expect(JSON.parse(new TextDecoder().decode(raw.bytes))).toEqual(future);
    // 未缓存未知版本：节点当前项目仍是原 v1（不被未知版本污染）。
    expect(h.state.projectId).toBe("gf-proj");
  });

  it("saveProject 拒绝以当前 schema 覆盖未来版本内容", async () => {
    const h = await newHarness();
    const result = await h.controller.saveProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, state: { schemaVersion: 2, projectId: "gf-x" } as never });
    expect(result).toMatchObject({ ok: false, code: "unsupported-version" });
  });
});

describe("finalize 结果校验、构建保存与版本（任务 7.1–7.7）", () => {
  async function generated(overrides: Partial<GameFurnaceState> = {}) {
    const h = await newHarness(initialState(overrides));
    const gen = await h.controller.generate(h.request());
    expect(gen.ok).toBe(true);
    return { h, generationId: String(gen.generationId), workerTaskKey: String(gen.workerTaskKey), inputHash: String(gen.inputHash) };
  }

  it("任务未成功时不宣告可用", async () => {
    const { h, generationId, workerTaskKey } = await generated();
    h.taskStatus.set(workerTaskKey, "executing");
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId })).toMatchObject({ ok: true, state: "executing" });
  });

  it("成功但取不到完整代码时拒绝（不得用摘要代替）", async () => {
    const { h, generationId, workerTaskKey } = await generated();
    h.taskStatus.set(workerTaskKey, "succeeded");
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId })).toMatchObject({ ok: false, code: "invalid-game-output" });
  });

  it("畸形/引用未声明资源的结果不激活，旧 activeBuild 保留", async () => {
    const { h, generationId, workerTaskKey } = await generated();
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, "```html\n<html><body><img src=\"assets/nope.png\"><script>1</script></body></html>\n```");
    const result = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(result).toMatchObject({ ok: false, code: "undeclared-resource" });
    expect(h.state.builds).toHaveLength(0);
  });

  it("成功且输入未变：保存不可变构建、原子登记并自动激活", async () => {
    const { h, generationId, workerTaskKey, inputHash } = await generated();
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "方向键", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    const result = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(result).toMatchObject({ ok: true, state: "succeeded", autoActivate: true });
    const state = h.state;
    expect(state.builds).toHaveLength(1);
    expect(state.activeBuildId).toBe(state.builds[0]!.buildId);
    expect(state.builds[0]!.inputHash).toBe(inputHash);
    expect(state.generations.find((g) => g.generationId === generationId)!.disposition).toBe("active");
    // 节点只保存稳定关联与 hash，不含大段 HTML。
    expect(JSON.stringify(state)).not.toContain(VALID_HTML);
    expect(h.storedBytes.size).toBeGreaterThanOrEqual(3); // 项目 envelope + manifest + source package
  });

  it("成功但输入已变：build 成为候选，不自动激活", async () => {
    const { h, generationId, workerTaskKey } = await generated();
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    // 完成后（finalize 前）修改需求：不再是 latest 输入。
    const current = h.state;
    const mutated = reduceGameFurnace(current as never, [{ type: "requirements.patch", patch: { description: "改成赛跑" } }] as never) as unknown as GameFurnaceState;
    await h.setState(mutated);
    const result = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(result).toMatchObject({ ok: true, autoActivate: false });
    const state = h.state;
    expect(state.activeBuildId).toBeUndefined();
    expect(state.generations.find((g) => g.generationId === generationId)!.disposition).toBe("candidate");
  });
});

describe("本站隔离预览（任务 8.1–8.4）", () => {
  async function built() {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    const generationId = String(gen.generationId);
    const workerTaskKey = String(gen.workerTaskKey);
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    const finalized = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    return { h, buildId: String(finalized.buildId) };
  }

  it("openPreview 按固定 buildId 建立短期只读会话，返回入口与授权资源", async () => {
    const { h, buildId } = await built();
    const opened = await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId });
    expect(opened.ok).toBe(true);
    const sessionId = String(opened.sessionId);
    const entry = h.controller.previewFetch(sessionId, "index.html")!;
    expect(entry.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    // 越界/未登记路径拒绝。
    expect(h.controller.previewFetch(sessionId, "../secret")).toBeNull();
    expect(h.controller.previewFetch(sessionId, "assets/unknown.png")).toBeNull();
  });

  it("未知 buildId / 未知会话拒绝", async () => {
    const { h } = await built();
    expect(await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: "ghost" })).toMatchObject({ ok: false, code: "target-missing" });
    expect(h.controller.previewFetch("gfp-deadbeef", "index.html")).toBeNull();
  });

  it("移除当前素材后旧 build 仍能读取其固定资源（任务 7.8）", async () => {
    const { h, buildId } = await built();
    // 试玩一次确认资源可读。
    const before = await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId });
    expect(h.controller.previewFetch(String(before.sessionId), "assets/res-hero.png")!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    // 从当前项目清单移除该素材；历史 build 的 manifest 冻结了 storageKey。
    const removed = reduceGameFurnace(h.state as never, [{ type: "resources.remove", resourceIds: ["res-hero"] }] as never) as unknown as GameFurnaceState;
    await h.setState(removed);
    expect(h.state.resources).toHaveLength(0);
    // 旧 build 不受移除影响，仍能按冻结键读取固定资源。
    const after = await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId });
    expect(after).toMatchObject({ ok: true });
    expect(h.controller.previewFetch(String(after.sessionId), "assets/res-hero.png")!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("未装配（dispose 后）时返回 plugin-disabled", async () => {
    const h = await newHarness();
    h.controller.dispose();
    expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "plugin-disabled" });
  });
});

// ---------------------------------------------------------------------------
// 任务 7.7：显式采用候选/历史构建
// ---------------------------------------------------------------------------

describe("显式采用构建为活动版本（任务 7.7）", () => {
  it("候选构建显式采用后成为活动版本；不改变构建内容与 inputHash", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    const workerTaskKey = String(gen.workerTaskKey);
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    // 输入变化：完成的构建成为候选，不自动激活。
    const current = h.state;
    const mutated = reduceGameFurnace(current as never, [{ type: "requirements.patch", patch: { description: "改成赛跑" } }] as never) as unknown as GameFurnaceState;
    await h.setState(mutated);
    const finalized = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(gen.generationId) });
    expect(finalized).toMatchObject({ ok: true, autoActivate: false });
    expect(h.state.activeBuildId).toBeUndefined();
    const buildId = String(finalized.buildId);
    const hashBefore = computeInputHash(h.state);
    const buildsBefore = h.state.builds.length;

    const activated = await h.controller.activateBuild({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId });
    expect(activated).toMatchObject({ ok: true, activeBuildId: buildId });
    // 显式采用返回持久项目关联（前端据此写回节点）。
    expect(activated).toMatchObject({ project: { state: { activeBuildId: buildId } } });
    const state = h.state;
    expect(state.activeBuildId).toBe(buildId);
    expect(state.builds).toHaveLength(buildsBefore);
    expect(computeInputHash(state)).toBe(hashBefore);
    // 该 generation 被显式采用并标注。
    const generation = state.generations.find((g) => g.generationId === String(gen.generationId))!;
    expect(generation.disposition).toBe("active");
    expect(generation.candidateBuildId).toBe(buildId);
    // 刷新后仍为活动版本。
    await h.restart();
    expect(h.state.activeBuildId).toBe(buildId);
  });

  it("未知 buildId 拒绝，不改变活动版本", async () => {
    const h = await newHarness();
    expect(await h.controller.activateBuild({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: "ghost" })).toMatchObject({ ok: false, code: "target-missing" });
    expect(h.state.activeBuildId).toBeUndefined();
  });

  it("项目删除后采用返回 target-missing", async () => {
    const h = await newHarness();
    h.deleteProject();
    expect(await h.controller.activateBuild({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: "build-x" })).toMatchObject({ ok: false, code: "target-missing" });
  });
});



describe("从画布拖入收集素材（任务 4.3/4.4）", () => {
  const collectOp = {
    type: "resources.add",
    resources: [
      {
        resourceId: "res-slime",
        kind: "image",
        name: "史莱姆",
        category: "图片",
        description: "",
        payload: { kind: "asset", assetIds: ["asset-2"] },
        metadata: { mime: "image/png", storageKey: "sha256-b", previewAssetId: "asset-2" }
      }
    ]
  };

  it("追加素材写入新 envelope：storageKey/inputHash 变化，旧素材保留", async () => {
    const h = await newHarness();
    const before = h.state;
    const result = await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [collectOp] });
    expect(result).toMatchObject({ ok: true });
    expect(typeof result.projectStorageKey).toBe("string");
    const after = h.state;
    expect(after.resources.map((r) => r.resourceId)).toEqual(["res-hero", "res-slime"]);
    expect(computeInputHash(after)).toBe(result.inputHash);
    expect(computeInputHash(after)).not.toBe(computeInputHash(before));
  });

  it("收集响应丢失后按最新关联重试同一稳定资源 ID 不重复添加（任务 4.10）", async () => {
    const h = await newHarness();
    const first = await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [collectOp] });
    expect(first).toMatchObject({ ok: true });

    // 首次响应假设丢失：客户端重新打开 canonical 节点关联后，以最新 key 重放同一 drop。
    const retry = await h.controller.collectResources({
      canvasId: CANVAS_ID,
      nodeId: NODE_ID,
      operations: [collectOp],
      expectedProjectStorageKey: String(first.projectStorageKey)
    });
    expect(retry).toMatchObject({ ok: true });
    expect(h.state.resources.map((resource) => resource.resourceId)).toEqual(["res-hero", "res-slime"]);

    const refreshed = await h.refreshFromNode(String(retry.projectStorageKey));
    expect(refreshed).toMatchObject({ ok: true });
    expect(h.state.resources.find((resource) => resource.resourceId === "res-slime")).toMatchObject({
      payload: { kind: "asset", assetIds: ["asset-2"] },
      metadata: { storageKey: "sha256-b", mime: "image/png" }
    });
  });

  it("项目不存在时以确定性 projectId 自动初始化", async () => {
    const h = await newHarness();
    h.deleteProject();
    const result = await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [collectOp] });
    expect(result).toMatchObject({ ok: true });
    expect(h.state.resources.map((r) => r.resourceId)).toEqual(["res-slime"]);
    expect(h.state.projectId.startsWith("gf-")).toBe(true);
  });

  it("目标修订重验：expectedProjectStorageKey 与内存快照不符时拒绝整批（任务 4.4）", async () => {
    const h = await newHarness();
    const writesBefore = h.writeCalls.length;
    const result = await h.controller.collectResources({
      canvasId: CANVAS_ID,
      nodeId: NODE_ID,
      operations: [collectOp],
      expectedProjectStorageKey: "sha256-stale"
    });
    expect(result).toMatchObject({ ok: false, code: "content-conflict" });
    expect(h.writeCalls.length).toBe(writesBefore);
    // 匹配的基线仍可成功。
    const matched = await h.controller.collectResources({
      canvasId: CANVAS_ID,
      nodeId: NODE_ID,
      operations: [collectOp],
      expectedProjectStorageKey: h.projectStorageKey
    });
    expect(matched).toMatchObject({ ok: true });
  });

  it("非法操作整批拒绝（content-conflict），不写新对象", async () => {
    const h = await newHarness();
    const writesBefore = h.writeCalls.length;
    const result = await h.controller.collectResources({
      canvasId: CANVAS_ID,
      nodeId: NODE_ID,
      operations: [{ type: "resources.add", resources: [] }] as never
    });
    expect(result).toMatchObject({ ok: false, code: "content-conflict" });
    expect(h.writeCalls.length).toBe(writesBefore);
    expect(h.state.resources).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 任务 6.9：生成幂等、重启/响应丢失、无前端收尾
// ---------------------------------------------------------------------------

describe("生成幂等与恢复（任务 6.9）", () => {
  it("重复点击/响应丢失：同一逻辑输入复用同一 generationId/workerTaskKey，只提交一次 Task", async () => {
    const h = await newHarness();
    const first = await h.controller.generate(h.request());
    expect(first.ok).toBe(true);
    expect(h.submitCalls).toHaveLength(1);
    // 第二次带当前输入 hash（generation.link 不改变 inputHash），仍解析到同一逻辑生成。
    const second = await h.controller.generate(h.request());
    expect(second).toMatchObject({ ok: true, reused: true, generationId: first.generationId, workerTaskKey: first.workerTaskKey });
    expect(h.submitCalls).toHaveLength(1);
    expect(h.state.generations).toHaveLength(1);
  });

  it("后端重启且 Task 已存活：原 key 查询复用，不重复调用模型", async () => {
    const h = await newHarness();
    const first = await h.controller.generate(h.request());
    h.taskStatus.set(String(first.workerTaskKey), "running");
    await h.restart();
    const after = await h.controller.generate(h.request());
    expect(after).toMatchObject({ ok: true, reused: true, state: "running", generationId: first.generationId, workerTaskKey: first.workerTaskKey });
    expect(h.submitCalls).toHaveLength(1);
  });

  it("提交/关联响应丢失（Task 无记录）：重启后以原 key 幂等补交，不换 key", async () => {
    const h = await newHarness();
    const first = await h.controller.generate(h.request());
    // 模拟响应丢失/重启后 Task 未记录该 key，而项目仍保留 generation。
    h.taskStatus.delete(String(first.workerTaskKey));
    await h.restart();
    expect(h.taskStatus.has(String(first.workerTaskKey))).toBe(false);
    const resubmit = await h.controller.generate(h.request());
    expect(resubmit).toMatchObject({ ok: true, reused: true, resubmitted: true, workerTaskKey: first.workerTaskKey, generationId: first.generationId });
    expect(h.submitCalls).toHaveLength(2);
    expect(h.submitCalls[0]!.workerTaskKey).toBe(h.submitCalls[1]!.workerTaskKey);
  });

  it("已失败/取消的生成：以原 key 重新提交同一意图", async () => {
    const h = await newHarness();
    const first = await h.controller.generate(h.request());
    h.taskStatus.set(String(first.workerTaskKey), "failed");
    const retry = await h.controller.generate(h.request());
    expect(retry).toMatchObject({ ok: true, reused: true, resubmitted: true, workerTaskKey: first.workerTaskKey });
    expect(h.submitCalls).toHaveLength(2);
  });

  it("无前端在线：后端独立 finalize 并原子激活", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    const finalized = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(gen.generationId) });
    expect(finalized).toMatchObject({ ok: true, state: "succeeded", autoActivate: true });
    const state = h.state;
    expect(state.builds).toHaveLength(1);
    expect(state.activeBuildId).toBe(state.builds[0]!.buildId);
  });

  it("自动后台收尾：无前端轮询即在途生成被收尾并原子激活（任务 6.9）", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    // 不调用任何前端 finalize：后台 worker 的 sweep 自行完成收尾。
    expect(await h.flushFinalizations()).toMatchObject({ processed: 1 });
    expect(h.state.builds).toHaveLength(1);
    expect(h.state.activeBuildId).toBe(h.state.builds[0]!.buildId);
    expect(h.state.generations[0]!.disposition).toBe("active");
    // 已收尾的生成不再重复处理。
    expect(await h.flushFinalizations()).toMatchObject({ processed: 0 });
  });

  it("自动后台收尾：进行中生成暂不处理，完成后下轮收尾（不产生第二事实源）", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "running");
    expect(await h.flushFinalizations()).toMatchObject({ processed: 0 });
    expect(h.state.builds).toHaveLength(0);
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    expect(await h.flushFinalizations()).toMatchObject({ processed: 1 });
    expect(h.state.builds).toHaveLength(1);
  });

  it("重启恢复：openProject 自动触发后台收尾，无需前端轮询（任务 6.9）", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    await h.restart();
    // openProject 的 kick 自动 sweep；这里只让事件循环推进，不主动调用 flushFinalizations。
    for (let i = 0; i < 100 && h.state.builds.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(h.state.builds).toHaveLength(1);
    expect(h.state.activeBuildId).toBe(h.state.builds[0]!.buildId);
    expect(h.state.generations[0]!.disposition).toBe("active");
  });

  it("后台收尾的新 key 在刷新时从旧节点关联重放并恢复；旧 key 不覆盖当前进程新状态（任务 6.9）", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    // generate handler 已写回 generation.link 关联；之后旧 key 才是刷新时 canonical 节点可能持有的值。
    const nodeAssociationKey = h.projectStorageKey;
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));

    // 后台 worker 自动收尾（无前端）：仅在服务端写新的内容寻址 envelope + 内存快照。
    expect(await h.flushFinalizations()).toMatchObject({ processed: 1 });
    expect(h.state.builds).toHaveLength(1);
    // 服务端内存快照已前移到新键（≠ 节点保存的键），因为 build.register 重新保存了 envelope。
    const workerKey = h.projectStorageKey;
    expect(workerKey).not.toBe(nodeAssociationKey);

    // 同一进程收到迟到旧关联，不得回滚 worker 已完成的项目快照。
    const staleInProcess = await h.controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: nodeAssociationKey });
    expect(staleInProcess).toMatchObject({ ok: true, projectStorageKey: workerKey, state: { builds: [{ buildId: h.state.builds[0]!.buildId }] } });

    // 模拟服务重启后的浏览器刷新：canonical 节点仍只有旧 key，openProject 通过 Task 原 key 重放收尾。
    const reopened = await h.refreshFromNode(nodeAssociationKey);
    expect(reopened).toMatchObject({ ok: true, state: { builds: [{ buildId: h.state.builds[0]!.buildId }], activeBuildId: h.state.builds[0]!.buildId } });
    expect((reopened as { projectStorageKey: string }).projectStorageKey).not.toBe(nodeAssociationKey);
    expect((reopened as { state: GameFurnaceState }).state.generations[0]!.disposition).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 任务 6.10：停用准入、draining 收尾、目标删除、A/B 乱序
// ---------------------------------------------------------------------------

describe("停用/删除/晚到结果（任务 6.10）", () => {
  async function generatedWith(h: Harness) {
    const gen = await h.controller.generate(h.request());
    expect(gen.ok).toBe(true);
    return { generationId: String(gen.generationId), workerTaskKey: String(gen.workerTaskKey) };
  }

  it("后端停用：新逻辑输入拒绝准入；既有生成仍可复用与收尾", async () => {
    const h = await newHarness();
    const { generationId, workerTaskKey } = await generatedWith(h);
    h.setAdmitted(false);
    // 既有逻辑输入复用不受停用影响（不新准入）。
    expect(await h.controller.generate(h.request())).toMatchObject({ ok: true, reused: true });
    // 新输入需要新准入 → 被拒。
    const current = h.state;
    const mutated = reduceGameFurnace(current as never, [{ type: "requirements.patch", patch: { description: "改成赛跑" } }] as never) as unknown as GameFurnaceState;
    await h.setState(mutated);
    expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "work-not-ready" });
    // draining：在途生成仍能收尾（无前端）。
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    const finalized = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(finalized).toMatchObject({ ok: true, state: "succeeded" });
    expect(h.state.builds).toHaveLength(1);
  });

  it("目标 generation 删除：finalize 返回 target-missing，不重建、不误关联", async () => {
    const h = await newHarness();
    await generatedWith(h);
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: "gen-ghost" })).toMatchObject({ ok: false, code: "target-missing" });
    expect(h.state.builds).toHaveLength(0);
  });

  it("节点项目被删除：finalize 返回 target-missing，不复活项目", async () => {
    const h = await newHarness();
    const { generationId } = await generatedWith(h);
    h.deleteProject();
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId })).toMatchObject({ ok: false, code: "target-missing" });
    expect(h.submitCalls).toHaveLength(1); // 不产生新任务
  });

  it("目标删除：detachTarget 取消在途站点任务并脱离内存项目；晚到结果不重建、不误关联（任务 6.10）", async () => {
    const h = await newHarness();
    const { generationId, workerTaskKey } = await generatedWith(h);
    const detached = await h.controller.detachTarget({ canvasId: CANVAS_ID, nodeId: NODE_ID });
    expect(detached).toEqual({ ok: true, detached: 1 });
    // 在途站点任务被按原 key 取消；内存项目已脱离。
    expect(h.cancelCalls).toEqual([workerTaskKey]);
    expect(h.controller.runtime()!.projects.has(PROJECT_KEY)).toBe(false);
    // 晚到成功结果不能重建节点或登记新 build。
    h.taskStatus.set(workerTaskKey, "succeeded");
    h.taskResults.set(workerTaskKey, JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId })).toMatchObject({ ok: false, code: "target-missing" });
    expect(h.controller.runtime()!.projects.has(PROJECT_KEY)).toBe(false);
  });

  it("目标删除：Agent 源码提交不对应站点 Task，仅脱离不取消（任务 6.10）", async () => {
    const h = await newHarness();
    // 直接注入一条 Agent 生成记录（无站点 Task）。
    const current = h.state;
    await h.setState({ ...current, generations: [{ generationId: "gen-agent", workerTaskKey: "agent-source", origin: "agent", inputHash: "h", admittedAt: new Date().toISOString(), disposition: "candidate" }] } as GameFurnaceState);
    expect(await h.controller.detachTarget({ canvasId: CANVAS_ID, nodeId: NODE_ID })).toEqual({ ok: true, detached: 1 });
    expect(h.cancelCalls).toEqual([]);
    expect(h.controller.runtime()!.projects.has(PROJECT_KEY)).toBe(false);
  });

  it("A/B 乱序：晚到的旧输入结果至多候选，不覆盖较新活动的 B", async () => {
    const h = await newHarness();
    const genA = await h.controller.generate(h.request());
    // 修改输入得到 B（新的 latest）。
    const current = h.state;
    const mutated = reduceGameFurnace(current as never, [{ type: "requirements.patch", patch: { description: "赛跑版本" } }] as never) as unknown as GameFurnaceState;
    await h.setState(mutated);
    const genB = await h.controller.generate(h.request());
    const keyA = String(genA.workerTaskKey);
    const keyB = String(genB.workerTaskKey);
    const resultPayload = JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] });
    // B 先完成并激活。
    h.taskStatus.set(keyB, "succeeded");
    h.taskResults.set(keyB, resultPayload);
    const finalizedB = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(genB.generationId) });
    expect(finalizedB).toMatchObject({ ok: true, autoActivate: true });
    const activeAfterB = h.state.activeBuildId;
    // A 晚到：成为候选，不覆盖 B。
    h.taskStatus.set(keyA, "succeeded");
    h.taskResults.set(keyA, resultPayload);
    const finalizedA = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(genA.generationId) });
    expect(finalizedA).toMatchObject({ ok: true, autoActivate: false });
    const state = h.state;
    expect(state.activeBuildId).toBe(activeAfterB);
    expect(state.generations.find((g) => g.generationId === String(genA.generationId))!.disposition).toBe("candidate");
  });
});

// ---------------------------------------------------------------------------
// 任务 7.5：构建幂等与断点恢复
// ---------------------------------------------------------------------------

describe("构建幂等与断点恢复（任务 7.5）", () => {
  async function succeededGen(h: Harness) {
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "跳跃", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    return String(gen.generationId);
  }

  it("重复 finalize 相同 generation/源码：一个逻辑 build，不重复写 manifest/source 对象", async () => {
    const h = await newHarness();
    const generationId = await succeededGen(h);
    const first = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(first.ok).toBe(true);
    const firstBuild = h.state.builds[0]!;
    const writesAfterFirst = h.writeCalls.length;
    expect(h.state.builds).toHaveLength(1);
    const second = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(second).toMatchObject({ ok: true, buildId: first.buildId });
    expect(h.state.builds).toHaveLength(1);
    // 复用同一不可变 manifest/source 对象：build 关联稳定。
    const secondBuild = h.state.builds[0]!;
    expect(secondBuild.manifestAssetId).toBe(firstBuild.manifestAssetId);
    expect(secondBuild.sourceAssetId).toBe(firstBuild.sourceAssetId);
    // 仅多一次项目 envelope 写（语义登记），未重复写 manifest/source 对象。
    expect(h.writeCalls.length).toBe(writesAfterFirst + 1);
  });

  it("保存中途失败：不产生部分 build，保留旧 activeBuild；重试后幂等成功", async () => {
    const h = await newHarness();
    const generationA = await succeededGen(h);
    const builtA = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: generationA });
    expect(builtA).toMatchObject({ ok: true, autoActivate: true });
    const buildA = String(builtA.buildId);

    // 新输入生成 B。
    const current = h.state;
    const mutated = reduceGameFurnace(current as never, [{ type: "requirements.patch", patch: { description: "赛跑版本" } }] as never) as unknown as GameFurnaceState;
    await h.setState(mutated);
    const generationB = await succeededGen(h);

    // 写源码/manifest 失败：不登记 B，旧 A 保持活动，无孤儿版本。
    h.setFailWrites(true);
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: generationB })).toMatchObject({ ok: false, code: "build-store-failed" });
    let state = h.state;
    expect(state.builds).toHaveLength(1);
    expect(state.activeBuildId).toBe(buildA);

    // 恢复后重试：同一 buildId 幂等成功，B 成为活动。
    h.setFailWrites(false);
    const builtB = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: generationB });
    expect(builtB).toMatchObject({ ok: true, autoActivate: true });
    state = h.state;
    expect(state.builds).toHaveLength(2);
    expect(state.activeBuildId).toBe(String(builtB.buildId));
  });

  it("manifest 已保存但源码包未保存：无部分 build，旧 activeBuild 保留，重试幂等", async () => {
    const h = await newHarness();
    const generationId = await succeededGen(h);
    // 允许一次写（manifest），第二次写（源码包）失败：无部分 build 登记。
    h.failWritesAfter(h.writeCalls.length + 1);
    expect(await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId })).toMatchObject({ ok: false, code: "build-store-failed" });
    const state = h.state;
    // 不产生部分 build/活动版本。
    expect(state.builds).toHaveLength(0);
    expect(state.activeBuildId).toBeUndefined();
    const writes = h.writeCalls.length;
    // 恢复后同一 generation 重试：幂等成功，只增加一次逻辑 build。
    h.setFailWrites(false);
    h.failWritesAfter(Number.POSITIVE_INFINITY);
    const retried = await h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId });
    expect(retried).toMatchObject({ ok: true, autoActivate: true });
    const after = h.state;
    expect(after.builds).toHaveLength(1);
    expect(after.activeBuildId).toBe(String(retried.buildId));
    expect(h.writeCalls.length).toBeGreaterThan(writes);
  });
});


describe("生产工作区项目与取消", () => {
  it("打开缓存及媒体项目均返回完整状态，畸形状态不覆盖当前项目", async () => {
    const h = await newHarness();
    const project = h.controller.runtime()!.projects.get(PROJECT_KEY)!;
    expect(await h.controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: project.projectStorageKey }))
      .toMatchObject({ ok: true, state: h.state });
    expect(await h.controller.saveProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, state: { invalid: true } as never })).toMatchObject({ ok: false });
    expect(h.controller.runtime()!.projects.get(PROJECT_KEY)).toBe(project);
  });
  it("同项目历史关联往返恢复需求、素材与活动版本，不被当前缓存覆盖", async () => {
    const h = await newHarness();
    const built = await h.controller.submitGame({ ...h.request(), requestId: "history-a", html: VALID_HTML });
    expect(built.ok).toBe(true);
    const oldKey = h.projectStorageKey;
    const oldState = structuredClone(h.state);
    const edited = { ...h.state, requirements: { ...h.state.requirements, gameplay: "恢复前的新玩法" }, resources: [] };
    delete edited.activeBuildId;
    await h.setState(edited);
    const newKey = h.projectStorageKey;
    const newState = structuredClone(h.state);
    const restored = await h.controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: oldKey });
    expect(restored).toMatchObject({ ok: true, projectStorageKey: oldKey, state: oldState });
    const preview = await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: oldState.activeBuildId! });
    expect(preview.ok).toBe(true);
    expect(h.controller.previewFetch(String(preview.sessionId), "assets/res-hero.png")!.bytes).toEqual(h.storedBytes.get("sha256-a"));
    const redo = await h.controller.openProject({ canvasId: CANVAS_ID, nodeId: NODE_ID, projectStorageKey: newKey });
    expect(redo).toMatchObject({ ok: true, projectStorageKey: newKey, state: newState });
    expect(h.state).toEqual(newState);
  });

  it("生成与构建响应携带新的持久项目关联，刷新可恢复 generation", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    expect(gen).toMatchObject({ project: { state: { latestGenerationId: gen.generationId } } });
    await h.restart();
    expect(h.state.latestGenerationId).toBe(gen.generationId);
  });
  it("取消持久化后晚到成功结果不保存/激活新版本", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    const input = { canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(gen.generationId) };
    expect(await h.controller.cancel(input)).toMatchObject({ ok: true, state: "cancelled" });
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "游戏", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    expect(await h.controller.finalize(input)).toMatchObject({ ok: true, state: "cancelled" });
    expect(h.state.builds).toEqual([]);
    expect(h.state.activeBuildId).toBeUndefined();
    await h.restart();
    expect(h.state.generations[0]!.disposition).toBe("cancelled");
  });
  it("构建对象写入期间更改需求，收尾只能生成候选", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "游戏", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    const resources = h.controller.runtime()!.services.media.resources!;
    const write = resources.write;
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const storing = new Promise<void>(resolve => { started = resolve; });
    resources.write = async input => {
      if (JSON.parse(new TextDecoder().decode(input.bytes)).buildId) { started(); await barrier; }
      return write(input);
    };
    const finalize = h.controller.finalize({ canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(gen.generationId) });
    await storing;
    await h.setState({ ...h.state, requirements: { ...h.state.requirements, description: "新需求" } });
    release();
    expect(await finalize).toMatchObject({ ok: true, autoActivate: false });
    expect(h.state.activeBuildId).toBeUndefined();
    expect(h.state.requirements.description).toBe("新需求");
  });
  it("构建对象写入期间取消，晚到存储不能登记或激活构建", async () => {
    const h = await newHarness();
    const gen = await h.controller.generate(h.request());
    h.taskStatus.set(String(gen.workerTaskKey), "succeeded");
    h.taskResults.set(String(gen.workerTaskKey), JSON.stringify({ schemaVersion: 1, title: "游戏", controlsSummary: "", entry: "index.html", html: VALID_HTML, resourceIds: ["res-hero"] }));
    const resources = h.controller.runtime()!.services.media.resources!;
    const write = resources.write;
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const storing = new Promise<void>(resolve => { started = resolve; });
    resources.write = async input => {
      if (JSON.parse(new TextDecoder().decode(input.bytes)).buildId) { started(); await barrier; }
      return write(input);
    };
    const input = { canvasId: CANVAS_ID, nodeId: NODE_ID, generationId: String(gen.generationId) };
    const finalize = h.controller.finalize(input);
    await storing;
    expect(await h.controller.cancel(input)).toMatchObject({ ok: true, state: "cancelled" });
    release();
    expect(await finalize).toMatchObject({ ok: true, state: "cancelled" });
    expect(h.state.builds).toEqual([]);
    expect(h.state.activeBuildId).toBeUndefined();
    expect(h.state.generations[0]!.disposition).toBe("cancelled");
  });
});


describe("大素材完整原件持久化", () => {
  it.each(["text", "model3d", "future-node"])("%s 收集转存完整原件，重启与准备目录保留全部字节，重试不重复", async (type) => {
    const h = await projectHarness();
    const content = "完整原件\n".repeat(Math.max(MAX_INLINE_TEXT_CHARS, MAX_INLINE_SNAPSHOT_CHARS));
    const data = type === "text" ? { prompt: content } : type === "model3d" ? { modelScript: content } : { payload: content };
    const canvas = { id: CANVAS_ID, document: { nodes: [{ id: "large", type, position: { x: 0, y: 0 } }] }, nodeData: { large: data }, assets: [] };
    const plan = planGameFurnaceDrop(canvas as never, ["large"], "large-drop")!;
    const collected = await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: plan.operations });
    expect(collected, JSON.stringify(collected)).toMatchObject({ ok: true });
    const resource = h.state.resources.find(resource => resource.source?.nodeId === "large")!;
    const storageKey = resource.metadata!.storageKey!;
    const bytes = h.storedBytes.get(storageKey)!;
    if (type === "text") expect(new TextDecoder().decode(bytes)).toBe(content);
    else expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(type === "model3d" ? { modelScript: content } : { unknownNodeType: type, nodeData: data });
    expect(resource.payload.snapshot).toMatchObject({ overBudget: true, sourceAssetId: storageKey });
    expect(JSON.stringify(resource.payload.snapshot).length).toBeLessThan(1024);
    const originalHash = h.currentHash();
    expect(await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: plan.operations })).toMatchObject({ ok: true, inputHash: originalHash });
    expect(h.state.resources.filter(resource => resource.source?.nodeId === "large")).toHaveLength(1);
    await h.restart();
    const restored = h.state.resources.find(resource => resource.source?.nodeId === "large")!;
    expect(restored.metadata?.storageKey).toBe(storageKey);
    const references = await gameFurnaceArchiveDefinition.collectMediaKeys({ nodeData: { projectStorageKey: h.projectStorageKey }, read: async key => ({ bytes: h.storedBytes.get(key)!, contentType: "application/json" }) });
    expect(references).toContain(storageKey);
    const prepared = await h.controller.prepareProject(h.request());
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
    const file = (prepared.resources as { resourceId: string; path: string }[]).find(file => file.resourceId === restored.resourceId)!;
    expect(new Uint8Array(await readFile(path.join(String(prepared.projectDirectory), "public", file.path)))).toEqual(bytes);
    h.controller.dispose();
  });

  it("原件写入中失败不发布部分素材或新关联", async () => {
    const h = await newHarness();
    const originalKey = h.projectStorageKey, originalState = structuredClone(h.state);
    h.failWritesAfter(h.writeCalls.length + 1);
    const resources = ["a", "b"].map(resourceId => ({ resourceId, kind: "text", name: resourceId, payload: { kind: "text", assetIds: [], snapshot: { text: "大".repeat(MAX_INLINE_TEXT_CHARS + 1), overBudget: true } } }));
    expect(await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [{ type: "resources.add", resources }] as never })).toMatchObject({ ok: false, code: "storage-failed" });
    expect(h.projectStorageKey).toBe(originalKey);
    expect(h.state).toEqual(originalState);
    h.controller.dispose();
  });

  it("旧的只记字符数且没有原件的项目明确拒绝准备，不生成空文本", async () => {
    const h = await projectHarness();
    await h.setState({ ...h.state, resources: [{ resourceId: "legacy", kind: "text", name: "旧素材", category: "文本", description: "", payload: { kind: "text", assetIds: [], snapshot: { overBudget: true, textChars: 13000 } } }] });
    expect(await h.controller.prepareProject(h.request())).toMatchObject({ ok: false, code: "project-prepare-failed", message: expect.stringContaining("原件缺失") });
    h.controller.dispose();
  });
});


it("导演场及扩展素材的冻结依赖复制、重启、归档和历史站点保持完整", async () => {
  const h = await projectHarness();
  const image = new Uint8Array([10, 20, 30]), video = new Uint8Array([40, 50, 60]);
  h.storedBytes.set("sha256-film-image", image); h.storedBytes.set("sha256-film-video", video);
  const plane = { id: "image", kind: "image", name: "图片", assetId: "film-image", aspectRatio: 1, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
  const canvas = { id: CANVAS_ID, document: { nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }] },
    nodeData: { film: { extensionId: "film-set", filmSetContent: { schemaVersion: 3, items: [plane, { ...plane, id: "video", kind: "video", assetId: "film-video" }] }, filmSetAnimations: { schemaVersion: 1, clips: [], activeClipId: null }, sceneCamera: { eye: [1, 2, 3], target: [0, 0, 0] } } },
    assets: [{ id: "film-image", status: "ready", metadata: { storageKey: "sha256-film-image", contentType: "image/png" } }, { id: "film-video", status: "ready", metadata: { storageKey: "sha256-film-video", contentType: "video/mp4" } }] };
  const plan = planGameFurnaceDrop(canvas as never, ["film"], "film-drop")!;
  expect(await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: plan.operations })).toMatchObject({ ok: true });
  canvas.assets = []; canvas.document.nodes = []; // 来源已不存在，后续不得依赖来源表。
  await h.restart();
  const resource = h.state.resources.find(resource => resource.kind === "film-set")!;
  expect(resource.payload.snapshot).toMatchObject({ filmSetAnimations: { schemaVersion: 1, clips: [], activeClipId: null }, sceneCamera: { eye: [1, 2, 3], target: [0, 0, 0] } });
  const dependencies = resourceDependencyPaths(resource);
  expect(dependencies.map(asset => asset.storageKey)).toEqual(["sha256-film-image", "sha256-film-video"]);
  const prepared = await h.controller.prepareProject(h.request());
  expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
  const directory = String(prepared.projectDirectory);
  for (const [index, dependency] of dependencies.entries()) expect(new Uint8Array(await readFile(path.join(directory, "public", dependency.path)))).toEqual(index === 0 ? image : video);
  const references = await gameFurnaceArchiveDefinition.collectMediaKeys({ nodeData: { projectStorageKey: h.projectStorageKey }, read: async key => ({ bytes: h.storedBytes.get(key)!, contentType: "application/json" }) });
  expect(references).toEqual(expect.arrayContaining(["sha256-film-image", "sha256-film-video"]));
  await cp(path.join(directory, "public"), path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "dist/index.html"), '<!doctype html><html><body><script src="./main.js"></script></body></html>');
  await writeFile(path.join(directory, "dist/main.js"), 'document.body.dataset.playing="true";');
  const built = await h.controller.submitGame({ ...h.request(), requestId: "film-site", projectId: String(prepared.projectId) });
  expect(built, JSON.stringify(built)).toMatchObject({ ok: true });
  await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [{ type: "resources.remove", resourceIds: [resource.resourceId] }] as never });
  await h.restart();
  const opened = await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: String(built.buildId) });
  expect(opened).toMatchObject({ ok: true });
  for (const [index, dependency] of dependencies.entries()) expect(new Uint8Array(h.controller.previewFetch(String(opened.sessionId), dependency.path)!.bytes)).toEqual(index === 0 ? image : video);
  h.controller.dispose();
});

it("冻结依赖实际不存在时整批拒绝，不发布关联", async () => {
  const h = await newHarness(); const key = h.projectStorageKey;
  const resource = { resourceId: "missing", kind: "unknown", name: "失效素材", payload: { kind: "opaque", assetIds: ["missing-asset"], assets: [{ assetId: "missing-asset", storageKey: "sha256-missing", mime: "application/octet-stream" }], snapshot: { preserved: true } } };
  expect(await h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [{ type: "resources.add", resources: [resource] }] as never })).toMatchObject({ ok: false, code: "storage-failed" });
  expect(h.projectStorageKey).toBe(key); expect(h.state.resources).toHaveLength(1); h.controller.dispose();
});

it("登记前发现构建素材丢失时保留旧活动版本", async () => {
  const h = await newHarness();
  const built = await h.controller.submitGame({ ...h.request(), requestId: "before-missing", html: VALID_HTML });
  expect(built).toMatchObject({ ok: true }); const active = h.state.activeBuildId;
  h.storedBytes.delete("sha256-a");
  expect(await h.controller.submitGame({ ...h.request(), requestId: "after-missing", html: VALID_HTML.replace('score=0', 'score=1') })).toMatchObject({ ok: false, code: "build-resource-missing" });
  expect(h.state.activeBuildId).toBe(active); expect(h.state.builds).toHaveLength(1); h.controller.dispose();
});

it("转存原件期间项目被其他编辑更新时拒绝旧批次覆盖", async () => {
  const h = await newHarness();
  const media = h.controller.runtime()!.services.media.resources!;
  const originalWrite = media.write.bind(media);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  media.write = async input => { if (input.contentType === "text/plain") { entered(); await gate; } return originalWrite(input); };
  const pending = h.controller.collectResources({ canvasId: CANVAS_ID, nodeId: NODE_ID, operations: [{ type: "resources.add", resources: [{ resourceId: "late-large", kind: "text", name: "大文本", payload: { kind: "text", assetIds: [], snapshot: { text: "x".repeat(MAX_INLINE_TEXT_CHARS + 1) } } }] }] as never });
  await started;
  await h.setState({ ...h.state, requirements: { ...h.state.requirements, description: "新的远端需求" } });
  const currentKey = h.projectStorageKey;
  release();
  expect(await pending).toMatchObject({ ok: false, code: "content-conflict" });
  expect(h.projectStorageKey).toBe(currentKey); expect(h.state.requirements.description).toBe("新的远端需求");
  expect(h.state.resources.some(resource => resource.resourceId === "late-large")).toBe(false);
  h.controller.dispose();
});


it("输入清单写入失败不提交Task或链接半完成生成", async () => {
  const h = await newHarness(); h.setFailWrites(true);
  expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "input-manifest-failed" });
  expect(h.submitCalls).toHaveLength(0); expect(h.state.generations).toHaveLength(0); h.controller.dispose();
});

it("超过输入预算时明确拒绝，不截掉后面的生成规则或提交Task", async () => {
  const resources: GameFurnaceState["resources"] = Array.from({ length: 20 }, (_, index) => ({ resourceId: `text-${index}`, kind: "text", name: `素材${index}`, category: "文本", description: "长".repeat(12000), payload: { kind: "text", assetIds: [], snapshot: { text: "完整原文" } } }));
  const h = await newHarness(initialState({ resources }));
  expect(await h.controller.generate(h.request())).toMatchObject({ ok: false, code: "input-budget-exceeded" });
  expect(h.submitCalls).toHaveLength(0); expect(h.state.generations).toHaveLength(0); h.controller.dispose();
});

it("固定站点文件字节损坏时拒绝试玩，不把损坏文件作为成功加载", async () => {
  const h = await projectHarness();
  const prepared = await h.controller.prepareProject(h.request());
  const directory = String(prepared.projectDirectory);
  await cp(path.join(directory, "public"), path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "dist/index.html"), '<!doctype html><html><body><script src="./main.js"></script></body></html>');
  await writeFile(path.join(directory, "dist/main.js"), 'document.body.dataset.playing="true";');
  const built = await h.controller.submitGame({ ...h.request(), requestId: "tampered-site", projectId: String(prepared.projectId) });
  expect(built).toMatchObject({ ok: true });
  const pkg = decodeSourcePackage(h.storedBytes.get(h.state.builds[0]!.sourceAssetId)!);
  const file = pkg.site!.files.find(file => file.path === "main.js")!;
  const changed = h.storedBytes.get(file.storageKey)!.slice(); changed[0] ^= 1;
  h.storedBytes.set(file.storageKey, changed);
  expect(await h.controller.openPreview({ canvasId: CANVAS_ID, nodeId: NODE_ID, buildId: String(built.buildId) })).toMatchObject({ ok: false, code: "preview-resource-missing" });
  expect(h.state.activeBuildId).toBe(built.buildId); h.controller.dispose();
});


it("改写本地准备清单不能绕过权威素材完整性验证", async () => {
  const h = await projectHarness();
  const prepared = await h.controller.prepareProject(h.request()), directory = String(prepared.projectDirectory);
  const manifestFile = path.join(directory, ".furnace-project.json");
  const metadata = JSON.parse(await readFile(manifestFile, "utf8")); metadata.resources = [];
  await writeFile(manifestFile, JSON.stringify(metadata));
  await mkdir(path.join(directory, "dist"));
  await writeFile(path.join(directory, "dist/index.html"), '<!doctype html><html><body><script src="./main.js"></script></body></html>');
  await writeFile(path.join(directory, "dist/main.js"), 'document.body.dataset.ready="true";');
  expect(await h.controller.submitGame({ ...h.request(), requestId: "forged-manifest", projectId: String(prepared.projectId) })).toMatchObject({ ok: false, code: "project-publish-failed", message: expect.stringContaining("准备素材") });
  expect(h.state.builds).toHaveLength(0); h.controller.dispose();
});
