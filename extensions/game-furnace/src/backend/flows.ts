/**
 * 游戏炼丹炉后端：生成与收尾流程（含不可变构建保存、自动激活与预览会话）
 * （change: 2026-10-10-add-game-furnace-extension，任务 6/7/8 / design D8–D13）。
 *
 * 幂等：`generationId` 与 `workerTaskKey` 只由 `projectId + inputHash` 派生，不掺入易变的
 * workId，因此重复点击、提交响应丢失、刷新与后端重启都解析到**同一**逻辑生成。
 */
import { createHash } from "node:crypto";
import {
  buildContentHash,
  computeInputHash,
  GAME_POLICY_VERSION,
  reduceGameFurnace,
  resourceContentHash,
  resourceUsage,
  type GameFurnaceOperation,
  type GameFurnaceState
} from "../shared.js";
import {
  buildRecordFromManifest,
  collectResourceReferences,
  decodeGameResult,
  encodeSourcePackage,
  injectAssetMap,
  resourceRelativePath,
  resourceDependencyPaths,
  validateGameHtml,
  type GamePackageManifest
} from "../package.js";
import { GAME_SITE_BASE, readSourcePackageForPreview } from "../preview.js";
import { addAppBasePath } from "@woohaa3/contracts";
import type { GameSite } from "../site-contract.js";
import {
  admissionFailureMessage,
  compileInput,
  fnvHash,
  projectKey,
  runSaveProject,
  safeMessage,
  validateRequirements,
  type GenerateRequest,
  type Runtime
} from "./support.js";

/**
 * 生成主流程（任务 6.2–6.5 / 6.9）。
 *
 * 已受理的同一逻辑生成直接复用其 Task 状态；Task 查不到（响应丢失/重启）或已失败/取消时，
 * 以**原 workerTaskKey** 幂等补交（由 Task 层去重，不产生第二次模型调用）。只有全新逻辑输入
 * 才创建新 generation 并消耗一次工作准入。
 */
export async function runGeneration(rt: Runtime, input: GenerateRequest): Promise<Record<string, unknown>> {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  const state = project.state;
  const validation = validateRequirements(state.requirements);
  if (!validation.ok) return { ok: false, code: "invalid-requirements", message: validation.message };
  const modelKey = state.requirements.modelKey;
  if (!modelKey) return { ok: false, code: "language-model-unavailable", message: "未选择可执行文本模型，请到模型配置选择语言模型" };

  const inputHash = computeInputHash(state);
  const identityHash = fnvHash(`${state.projectId}\0${inputHash}`);
  const generationId = `gen-${identityHash}`;
  const workerTaskKey = `gf-${identityHash}`;
  let compiled: ReturnType<typeof compileInput>;
  try { compiled = compileInput(state, input.supportedInputs ?? []); }
  catch (error) { return { ok: false, code: "input-budget-exceeded", message: safeMessage(error) }; }
  const { prompt, inputs } = compiled;

  // 已受理的同一逻辑生成：优先复用，不产生第二次模型调用（提交响应丢失/刷新/重启/重复点击）。
  // 复用按 inputHash 判定，故不因自身 generation.link 造成的修订漂移而误判内容冲突。
  const existing = state.generations.find((candidate) => candidate.generationId === generationId);
  if (existing) {
    if (existing.disposition === "cancelled") return { ok: true, generationId, workerTaskKey, state: "cancelled", inputHash, reused: true };
    const status = await rt.services.tasks.status(workerTaskKey);
    if (status && status.state !== "failed" && status.state !== "cancelled") {
      rt.log({ event: "game-furnace-generation-reused", generationId, workerTaskKey, state: status.state });
      return { ok: true, generationId, workerTaskKey, state: status.state, inputHash, reused: true };
    }
    // Task 查不到（响应丢失/后端重启）或已失败/取消：以原 key 幂等补交同一意图。
    const resubmitted = await rt.services.tasks.submit({ workerTaskKey, modelType: "language", modelKey, prompt, parameters: {}, inputs });
    if (!resubmitted.ok) return { ok: false, code: resubmitted.code, message: resubmitted.message };
    rt.log({ event: "game-furnace-generation-resubmitted", generationId, workerTaskKey });
    return { ok: true, generationId, workerTaskKey, state: resubmitted.state, inputHash, reused: true, resubmitted: true };
  }

  // 全新逻辑输入：要求浏览器确认的输入 hash 未变（只对新生成入口检查）。
  if (inputHash !== input.expectedInputHash) {
    return { ok: false, code: "content-conflict", message: "项目内容已变化，请重新确认输入" };
  }
  // 只有全新逻辑输入才消耗一次工作准入；停用/draining 时拒绝新准入（既有生成仍可复用/收尾）。
  const admission = rt.work();
  if (!admission.ok) return { ok: false, code: "work-not-ready", message: admissionFailureMessage(admission.reason) };

  let inputManifestAssetId: string | undefined;
  if (rt.services.media.resources) {
    try {
      // 任务 6.4：服务端锁定**已确认**的 canonical 输入——记录 model、策略版本与每个素材的
      // 内容 checksum/冻结 storageKey/确定路径，使后续素材被移除或改写都不再改变本次输入事实源。
      const manifest = new TextEncoder().encode(JSON.stringify({
        inputHash,
        modelKey,
        policyVersion: GAME_POLICY_VERSION,
        resources: state.resources.map((r) => ({
          resourceId: r.resourceId,
          kind: r.kind,
          category: r.category,
          description: r.description,
          contentHash: resourceContentHash(r),
          path: resourceRelativePath(r),
          assetIds: r.payload.assetIds,
          ...(r.payload.assets ? { assets: r.payload.assets } : {}),
          ...(r.metadata?.storageKey ? { storageKey: r.metadata.storageKey } : {}),
          ...(r.metadata?.mime ? { mime: r.metadata.mime } : {})
        }))
      }));
      inputManifestAssetId = (await rt.services.media.resources.write({ bytes: manifest, contentType: "application/json" })).storageKey;
    } catch (error) {
      rt.log({ event: "game-furnace-input-manifest-failed", message: safeMessage(error) });
      rt.settleWork?.(admission.workId, "failed");
      return { ok: false, code: "input-manifest-failed", message: "无法保存本次生成输入，请重试" };
    }
  }

  const link: GameFurnaceOperation = {
    type: "generation.link",
    generation: {
      generationId,
      workerTaskKey,
      inputHash,
      ...(inputManifestAssetId ? { inputManifestAssetId } : {}),
      workId: admission.workId,
      pluginConfigVersion: admission.configVersion,
      admittedAt: new Date().toISOString(),
      disposition: "candidate"
    }
  };
  const linked = await applyOperations(rt, input.canvasId, input.nodeId, [link]);
  if (!linked.ok) return { ok: false, code: linked.code, message: linked.message };

  const submitted = await rt.services.tasks.submit({ workerTaskKey, modelType: "language", modelKey, prompt, parameters: {}, inputs });
  if (!submitted.ok) return { ok: false, code: submitted.code, message: submitted.message };
  rt.log({ event: "game-furnace-generation-admitted", generationId, workerTaskKey });
  return { ok: true, generationId, workerTaskKey, state: submitted.state, inputHash };
}

export async function runFinalize(rt: Runtime, input: { canvasId: string; nodeId: string; generationId: string }): Promise<Record<string, unknown>> {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  const generation = project.state.generations.find((candidate) => candidate.generationId === input.generationId);
  if (!generation) return { ok: false, code: "target-missing", message: "generation 不存在" };
  if (generation.disposition === "cancelled") return { ok: true, state: "cancelled" };
  const savedBuild = project.state.builds.find(build => build.buildId === generation.candidateBuildId && build.generationId === generation.generationId);
  if ((generation.origin === "agent" || generation.executionDetached) && savedBuild) return { ok: true, state: "succeeded", buildId: savedBuild.buildId,
    autoActivate: project.state.activeBuildId === savedBuild.buildId, sourceHash: savedBuild.sourceHash, reused: true };

  if (generation.executionDetached) return { ok: true, state: "cancelled", message: "复制记录已脱离原执行，请重新生成" };
  if (generation.origin === "agent") return { ok: false, code: "agent-source-not-built", message: "Agent 代码尚未形成已保存构建，请重新提交" };
  const status = await rt.services.tasks.status(generation.workerTaskKey);
  if (!status) return { ok: true, state: "unknown", message: "任务暂不可确认（正在恢复）" };
  if (status.state !== "succeeded") {
    if (status.state === "failed" || status.state === "cancelled") {
      const applied = await applyOperations(rt, input.canvasId, input.nodeId, [{ type: "generation.disposition", generationId: generation.generationId, disposition: status.state }]);
      if (!applied.ok) return applied;
      if (generation.workId) rt.settleWork?.(generation.workId, status.state);
    }
    return { ok: true, state: status.state };
  }
  const full = await rt.services.tasks.result?.(generation.workerTaskKey);
  const text = full?.result?.text;
  if (typeof text !== "string") return { ok: false, code: "invalid-game-output", message: "任务成功但未取到完整代码（不得用摘要代替源码）" };
  const result = await finalizeBuild(rt, project.state, input.canvasId, input.nodeId, input.generationId, generation.inputHash, text);
  if (result.ok === true && generation.workId) rt.settleWork?.(generation.workId, result.state === "cancelled" ? "cancelled" : "succeeded");
  return result;
}

/**
 * 显式采用候选/历史构建为活动版本（任务 7.7 / design D11）。
 *
 * 自动激活只在“最新 generation + 未取消 + inputHash 相同”时发生；当输入已变化时完成的构建
 * 只能作为候选。本入口让用户在**显式**选择后切换 activeBuildId。试玩 iframe 的重建由前端
 * 负责（切换后销毁旧 iframe、局部游戏状态清零），这里只改规范项目里的活动版本。
 */
export async function runActivateBuild(rt: Runtime, input: { canvasId: string; nodeId: string; buildId: string }): Promise<Record<string, unknown>> {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  const build = project.state.builds.find((candidate) => candidate.buildId === input.buildId);
  if (!build) return { ok: false, code: "target-missing", message: "构建版本不存在或不可读" };
  const generation = project.state.generations.find((candidate) => candidate.generationId === build.generationId);
  const operations: GameFurnaceOperation[] = [{ type: "build.activate", buildId: build.buildId }];
  // 构建对应的 generation 记录可能存在（正常生成/Agent 提交），也可能已被保留策略淘汰；仅在存在时标注。
  if (generation) operations.push({ type: "generation.disposition", generationId: build.generationId, disposition: "active", candidateBuildId: build.buildId });
  const applied = await applyOperations(rt, input.canvasId, input.nodeId, operations);
  if (!applied.ok) return { ok: false, code: applied.code, message: applied.message };
  rt.log({ event: "game-furnace-build-activated", buildId: build.buildId });
  return { ok: true, activeBuildId: build.buildId };
}

/**
 * 按当前授权项目与固定 buildId 创建短期只读预览会话（design D12 / 任务 8.1）。
 *
 * 会话 token 只在运行态返回，不写入 canonical 或源码包；刷新可重新申请。
 */
export async function runOpenPreview(rt: Runtime, input: { canvasId: string; nodeId: string; buildId: string }): Promise<Record<string, unknown>> {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  const build = project.state.builds.find((candidate) => candidate.buildId === input.buildId);
  if (!build) return { ok: false, code: "target-missing", message: "构建版本不存在或不可读" };
  if (!rt.services.media.resources) return { ok: false, code: "preview-policy-rejected", message: "缺少媒体读取能力" };
  let pkg;
  try {
    pkg = readSourcePackageForPreview((await rt.services.media.resources.read(build.sourceAssetId)).bytes);
  } catch (error) {
    return { ok: false, code: "preview-policy-rejected", message: safeMessage(error) };
  }
  if (!pkg) return { ok: false, code: "preview-policy-rejected", message: "源码包无法解析" };
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  try {
    if (pkg.site) {
      for (const file of pkg.site.files) {
        const saved = await rt.services.media.resources.read(file.storageKey);
        if (saved.bytes.length !== file.size || createHash("sha256").update(saved.bytes).digest("hex") !== file.checksum) throw Error("构建文件完整性校验失败");
        files.set(file.path, { bytes: saved.bytes, contentType: file.contentType });
      }
    }
    const resources = pkg.site ? new Map() : await readBuildResources(rt, pkg.manifest);
    const session = rt.preview.registerSession({ projectKey: projectKey(input.canvasId, input.nodeId), manifest: pkg.manifest, html: pkg.html, resources, files });
    return { ok: true, sessionId: session.sessionId, buildId: build.buildId, format: pkg.site ? "vite-static-site" : "legacy-static-site",
      // 入口 URL 是**公开**地址：逻辑站点前缀加一次当前挂载前缀（design D6）。
      entryUrl: `${addAppBasePath(rt.deploymentBasePath, `${GAME_SITE_BASE}/${session.sessionId}/index.html`)}`, files: pkg.site?.files.map(({ path, contentType, size }) => ({ path, contentType, size })) ?? [...files.keys()], expiresAt: session.expiresAt };
  } catch { return { ok: false, code: "preview-resource-missing", message: "构建文件缺失，无法打开试玩" }; }
}

export async function finalizeBuild(
  rt: Runtime,
  state: GameFurnaceState,
  canvasId: string,
  nodeId: string,
  generationId: string,
  inputHash: string,
  rawText: string,
  site?: GameSite
): Promise<Record<string, unknown>> {
  const decoded = decodeGameResult(rawText);
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };

  const resources = new Map(state.resources.map((resource) => [resource.resourceId, resource]));
  const allowedPaths = new Map<string, string>();
  for (const resource of state.resources) allowedPaths.set(resourceRelativePath(resource), resource.resourceId);

  const referencedIds = new Set<string>();
  for (const id of decoded.value.resourceIds) {
    if (!resources.has(id)) return { ok: false, code: "undeclared-resource", message: `引用不存在的资源：${id}` };
    referencedIds.add(id);
  }
  for (const ref of collectResourceReferences(decoded.value.html)) {
    const resourceId = allowedPaths.get(ref);
    if (!resourceId && site) continue; // Agent站点文件由固定产物清单供应。
    if (!resourceId) return { ok: false, code: "undeclared-resource", message: `引用了未声明资源：${ref}` };
    referencedIds.add(resourceId);
  }
  const htmlValidation = site ? { ok: true as const } : validateGameHtml({ html: decoded.value.html, allowedResourcePaths: new Set(allowedPaths.keys()), knownResourceIds: new Set(resources.keys()) });
  if (!htmlValidation.ok) return { ok: false, code: htmlValidation.code, message: htmlValidation.message };

  const dependencyAssetIds: string[] = [];
  const manifestResources: GamePackageManifest["resources"] = [];
  for (const resource of state.resources) {
    const used = referencedIds.has(resource.resourceId);
    const usage = used ? "used" : resourceUsage(resource).usage;
    const assetId = resource.metadata?.storageKey || resource.payload.kind === "asset" ? resource.payload.assetIds[0] ?? resource.metadata?.previewAssetId ?? "" : "";
    dependencyAssetIds.push(...resource.payload.assetIds);
    manifestResources.push({ resourceId: resource.resourceId, path: resourceRelativePath(resource), assetId, contentType: resource.metadata?.mime ?? "application/octet-stream", usage: usage as GamePackageManifest["resources"][number]["usage"], ...(resource.metadata?.storageKey ? { storageKey: resource.metadata.storageKey } : {}) });
  }
  for (const resource of state.resources) {
    for (const dependency of resourceDependencyPaths(resource)) manifestResources.push({ resourceId: resource.resourceId,
      path: dependency.path, assetId: dependency.assetId, contentType: dependency.mime, storageKey: dependency.storageKey,
      usage: resourceUsage(resource).usage });
  }
  const assetMap = Object.fromEntries([...referencedIds].map((id) => [id, resourceRelativePath(resources.get(id)!)]));
  const html = injectAssetMap(decoded.value.html, assetMap);
  const sourceHash = fnvHash(site ? JSON.stringify(site.files.map(file => [file.path, file.checksum])) : html);
  const buildId = `build-${buildContentHash({ inputHash, sourceHash, policyVersion: GAME_POLICY_VERSION, dependencyAssetIds }).slice(0, 20)}`;
  const manifest: GamePackageManifest = {
    schemaVersion: 1,
    buildId,
    title: decoded.value.title || state.requirements.name,
    controlsSummary: decoded.value.controlsSummary || state.requirements.gameplay || "",
    entry: "index.html",
    policyVersion: GAME_POLICY_VERSION,
    inputHash,
    sourceHash,
    dependencyAssetIds: [...new Set(dependencyAssetIds)],
    resources: manifestResources
  };

  if (!rt.services.media.resources) return { ok: false, code: "build-store-failed", message: "缺少媒体写入能力" };

  // 幂等收尾（任务 7.5）：相同 input/source 重试（响应丢失、重启、重复 finalize）解析到同一
  // 确定性 buildId，复用已保存的不可变对象，不重复写源码/manifest，也不新增版本或孤儿。
  const existingBuild = state.builds.find((candidate) => candidate.buildId === buildId);
  try { await readBuildResources(rt, manifest); }
  catch (error) { return { ok: false, code: "build-resource-missing", message: safeMessage(error) }; }

  let manifestAssetId: string;
  let sourceAssetId: string;
  if (existingBuild) {
    manifestAssetId = existingBuild.manifestAssetId;
    sourceAssetId = existingBuild.sourceAssetId;
  } else {
    try {
      manifestAssetId = (await rt.services.media.resources.write({ bytes: new TextEncoder().encode(JSON.stringify(manifest)), contentType: "application/json" })).storageKey;
      sourceAssetId = (await rt.services.media.resources.write({ bytes: encodeSourcePackage({ schemaVersion: 1, entry: "index.html", html, manifest, ...(site ? { site } : {}) }), contentType: "application/json" })).storageKey;
    } catch (error) {
      // 写失败：不登记任何 build，保留旧 activeBuild；同一 buildId 重试可幂等继续。
      return { ok: false, code: "build-store-failed", message: safeMessage(error) };
    }
  }

  const build = existingBuild ?? buildRecordFromManifest(manifest, { generationId, manifestAssetId, sourceAssetId, createdAt: new Date().toISOString() });
  // 写入不可变对象期间需求可能变化；提交前以最新项目复核，不能激活旧输入。
  const current = rt.projects.get(projectKey(canvasId, nodeId))?.state;
  if (!current || current.projectId !== state.projectId) return { ok: false, code: "target-missing", message: "项目已删除或替换" };
  const currentGeneration = current.generations.find(generation => generation.generationId === generationId);
  if (!currentGeneration) return { ok: false, code: "target-missing", message: "生成记录已删除" };
  if (currentGeneration.disposition === "cancelled") return { ok: true, state: "cancelled" };
  const stillLatest = current.latestGenerationId === generationId;
  const autoActivate = stillLatest && computeInputHash(current) === inputHash;
  const operations: GameFurnaceOperation[] = [
    { type: "build.register", build },
    { type: "generation.disposition", generationId, disposition: autoActivate ? "active" : "candidate", candidateBuildId: build.buildId, ...(autoActivate ? {} : { diagnostic: "基于较早输入，未自动激活" }) },
    ...(autoActivate ? [{ type: "build.activate", buildId: build.buildId } as GameFurnaceOperation] : [])
  ];
  const applied = await applyOperations(rt, canvasId, nodeId, operations);
  if (!applied.ok) return { ok: false, code: applied.code, message: applied.message };

  // 登记短期只读预览会话：固定 build/sourceHash/policyVersion，素材按 manifest 从稳定资产读取。
  // 试玩在用户申请时读取固定站点文件；保存阶段不创建占用内存的预览会话。
  rt.log({ event: "game-furnace-build-stored", buildId, autoActivate });
  return { ok: true, state: "succeeded", buildId, autoActivate, sourceHash };
}

/**
 * 按 manifest 从稳定素材读取字节。
 *
 * 优先使用 manifest 中冻结的 `storageKey`（任务 7.8）：这样即使素材已从当前项目清单移除，
 * 历史 build 仍能读取其不可变原件（当前素材只有在仍存在时才作为旧 manifest 的回退查找）。
 * 缺失/不可读跳过，预览仍可显示 HTML。
 */
export async function readBuildResources(rt: Runtime, manifest: GamePackageManifest): Promise<Map<string, { bytes: Uint8Array; contentType: string }>> {
  const out = new Map<string, { bytes: Uint8Array; contentType: string }>();
  if (!rt.services.media.resources) return out;
  const project = [...rt.projects.values()].find((candidate) => candidate.state.builds.some((build) => build.buildId === manifest.buildId));
  const resourceByAssetId = new Map<string, GameFurnaceState["resources"][number]>();
  if (project) {
    for (const resource of project.state.resources) {
      for (const id of resource.payload.assetIds) resourceByAssetId.set(id, resource);
      if (resource.metadata?.previewAssetId) resourceByAssetId.set(resource.metadata.previewAssetId, resource);
    }
  }
  for (const entry of manifest.resources) {
    // 冻结键优先（不依赖当前素材仍然存在）；否则回退到当前项目的稳定键（旧 manifest）。
    const storageKey = entry.storageKey || (entry.assetId ? resourceByAssetId.get(entry.assetId)?.metadata?.storageKey : undefined);
    if (typeof storageKey !== "string" || storageKey === "") continue;
    try {
      const value = await rt.services.media.resources.read(storageKey);
      out.set(entry.assetId, { bytes: value.bytes, contentType: value.contentType });
    } catch { throw Error(`构建素材不可读：${entry.path}`); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 语义操作辅助（内容寻址项目快照 → 纯 reducer → 重新保存）
// ---------------------------------------------------------------------------

/**
 * 应用一批语义操作（整批原子），成功后把新 envelope 写回 Media 并更新内存快照。
 * 替代原 `canvas.containers.apply`（新架构无该能力，见 port-plan 阶段 5）。
 */
export async function applyOperations(
  rt: Runtime,
  canvasId: string,
  nodeId: string,
  operations: GameFurnaceOperation[]
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const key = projectKey(canvasId, nodeId);
  const project = rt.projects.get(key);
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  let next: GameFurnaceState;
  try {
    next = reduceGameFurnace(project.state as never, operations as never) as unknown as GameFurnaceState;
  } catch (error) {
    return { ok: false, code: "content-conflict", message: safeMessage(error) };
  }
  if (!rt.services.media.resources) {
    // 无存储能力：仅在内存中前进（调用方随后应重新 saveProject）；不产生稳定关联。
    rt.projects.set(key, { ...project, state: next, inputHash: computeInputHash(next) });
    return { ok: true };
  }
  try {
    const saved = await runSaveProject(rt, { canvasId, nodeId, state: next });
    if (saved.ok !== true) return { ok: false, code: String(saved.code), message: String(saved.message) };
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "storage-failed", message: safeMessage(error) };
  }
}
