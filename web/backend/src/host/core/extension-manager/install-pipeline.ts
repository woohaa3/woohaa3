/**
 * 安装流水线：download → verify → stage → preflight → commit → reload（从 manager.ts 拆出）。
 *
 * 唯一提交点是 `installations.json` 的原子替换；提交前的任何失败只删 `staging/<jobId>`。
 * 所有共享状态经 `ManagerContext` 显式传入。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MARKETPLACE_LOCAL_FILE_SOURCE_ID,
  type ExtensionInstallJobView,
  type ExtensionInstallOutcome,
  type ExtensionTrust,
  type MarketplaceFailureCode,
  type ReleaseRef
} from "@woohaa3/contracts";
import { ExtensionManagerError, toManagerError } from "./errors.js";
import type { Job } from "./jobs.js";
import type { ManagerContext } from "./manager-context.js";
import { FAILURE_MESSAGES, type FileInstallRequest, type InstallRequest } from "./manager-types.js";
import type { InstallationRecord } from "./types.js";

/** 流式写包，限制大小，支持取消。 */
export async function writePackage(ctx: ManagerContext, job: Job, body: Readable | AsyncIterable<Uint8Array>, expectedSize?: number): Promise<string> {
  const { board, maxPackageBytes } = ctx;
  const dir = ctx.stagingFor(job);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "package.wxt");
  if (expectedSize !== undefined && expectedSize > maxPackageBytes) {
    throw new ExtensionManagerError("MARKETPLACE_PACKAGE_TOO_LARGE", `包大小 ${expectedSize} 字节超过上限 ${maxPackageBytes}`);
  }
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxPackageBytes) {
        callback(new ExtensionManagerError("MARKETPLACE_PACKAGE_TOO_LARGE", `包超过上限 ${maxPackageBytes} 字节`));
        return;
      }
      if (expectedSize) board.update(job, { progress: Math.min(1, received / expectedSize) });
      callback(null, chunk);
    }
  });
  const source = body instanceof Readable ? body : Readable.from(body);
  try {
    await pipeline(source, counter, fs.createWriteStream(file, { flags: "wx", mode: 0o644 }), { signal: job.controller.signal });
  } catch (error) {
    if (job.controller.signal.aborted) throw new ExtensionManagerError("MARKETPLACE_CANCELLED", "安装已取消");
    throw toManagerError(error, "MARKETPLACE_DOWNLOAD_FAILED");
  }
  if (received === 0) throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "包为空");
  return file;
}

export function checkDependencies(ctx: ManagerContext, dependencies: Readonly<Record<string, string>> | undefined): void {
  const { deps, toolkit } = ctx;
  if (!dependencies) return;
  const versions = deps.installedVersions?.() ?? new Map<string, string>();
  const problems: string[] = [];
  for (const [id, range] of Object.entries(dependencies)) {
    const installed = versions.get(id);
    if (!installed) problems.push(`缺少依赖 ${id}（需要 ${range}）`);
    else if (toolkit.satisfiesRange(installed, range) !== true) problems.push(`依赖 ${id}@${installed} 不满足 ${range}`);
  }
  if (problems.length > 0) throw new ExtensionManagerError("MARKETPLACE_DEPENDENCY_UNSATISFIED", problems.join("；"), problems);
}

export function checkBuiltinConflict(ctx: ManagerContext, extensionId: string): void {
  if (ctx.deps.builtinIds().has(extensionId)) {
    throw new ExtensionManagerError("MARKETPLACE_BUILTIN_CONFLICT", `扩展 ${extensionId} 已是内置扩展，不能再从市场安装`);
  }
}

/** 共用的 verify → stage → preflight → commit → reload。 */
export async function finishInstall(ctx: ManagerContext, job: Job, packageFile: string, ref: ReleaseRef | null) {
  const { deps, toolkit, board, maxPackageBytes, observeMs, now, log, requireHandle, stagingFor, assertNotAborted, cleanupStaging, commit, history, reload, switchPointer } = ctx;
  const h = requireHandle();
  const sourceId = job.sourceId;
  // verify：整包摘要（来源声明）
  board.update(job, { phase: "verify" });
  const digest = await toolkit.computePackageDigest(packageFile);
  if (ref && ref.packageDigest !== digest) {
    throw new ExtensionManagerError("MARKETPLACE_DIGEST_MISMATCH", `包摘要与来源声明不符（声明 ${ref.packageDigest}，实际 ${digest}）`);
  }
  assertNotAborted(job);
  // stage：安全解包
  board.update(job, { phase: "stage" });
  const tree = path.join(stagingFor(job), "tree");
  try {
    await toolkit.unpackExtensionPackage({ packagePath: packageFile, destDir: tree, limits: { maxPackageBytes } });
  } catch (error) {
    throw toManagerError(error, "MARKETPLACE_ARCHIVE_UNSAFE");
  }
  // verify：签名与逐文件摘要（信任根只来自本机配置；来源的任何声明都不算数）
  board.update(job, { phase: "verify" });
  const trustConfig = deps.trust();
  const allowUnsigned = sourceId === MARKETPLACE_LOCAL_FILE_SOURCE_ID && trustConfig.allowUnsignedLocal;
  let trust: ExtensionTrust;
  try {
    ({ trust } = await toolkit.verifyExtensionPackage({ treeDir: tree, trustedKeys: trustConfig.trustedKeys, allowUnsigned }));
  } catch (error) {
    throw toManagerError(error, "MARKETPLACE_SIGNATURE_INVALID");
  }
  assertNotAborted(job);
  // preflight：与 extensions:check 同一份静态检查，不执行扩展代码
  board.update(job, { phase: "preflight" });
  const preflight = await toolkit.preflightDirectory(tree, { managed: true });
  if (!preflight.ok || !preflight.extensionId || !preflight.version) {
    const has = (code: string) => preflight.errors.some((issue) => issue.code === code);
    // 优先级：禁止声明 > 引擎不兼容 > 缺构建期描述（旧包，需重新打包）> 通用预检失败。
    const code: MarketplaceFailureCode = has("MARKETPLACE_FORBIDDEN_DECLARATION")
      ? "MARKETPLACE_FORBIDDEN_DECLARATION"
      : has("MARKETPLACE_ENGINES_INCOMPATIBLE")
        ? "MARKETPLACE_ENGINES_INCOMPATIBLE"
        : has("MARKETPLACE_PACKAGE_INVALID")
          ? "MARKETPLACE_PACKAGE_INVALID"
          : "MARKETPLACE_PREFLIGHT_FAILED";
    const issues = preflight.errors.map((issue) => issue.message);
    throw new ExtensionManagerError(code, issues[0] ?? "预检失败", issues);
  }
  const extensionId = preflight.extensionId;
  const version = preflight.version;
  board.update(job, { extensionId, version });
  if (ref && (ref.extensionId !== extensionId || ref.version !== version)) {
    throw new ExtensionManagerError("MARKETPLACE_DIGEST_MISMATCH", `包内容是 ${extensionId}@${version}，与来源解析的 ${ref.extensionId}@${ref.version} 不一致`);
  }
  checkBuiltinConflict(ctx, extensionId);
  checkDependencies(ctx, preflight.dependencies);
  const filesDigest = await toolkit.filesDigest(tree);
  assertNotAborted(job);

  // commit：唯一提交点之前不可取消
  board.update(job, { phase: "commit" });
  return board.serial(async () => {
    job.committing = true;
    const state = h.read();
    const existing = state.extensions[extensionId];
    if (existing && existing.current === version && existing.filesDigest === filesDigest && existing.state !== "uninstalling") {
      cleanupStaging(job);
      return "already-current" as const;
    }
    const versionDir = h.layout.versionDir(extensionId, version);
    if (fs.existsSync(versionDir)) {
      // 同版本目录已存在（孤儿或旧 previous）：内容一致则复用，不一致拒绝覆盖。
      const present = await toolkit.filesDigest(versionDir);
      if (present !== filesDigest) {
        throw new ExtensionManagerError("MARKETPLACE_VERSION_CONTENT_CONFLICT", `${extensionId}@${version} 已存在且内容不同；同版本号不允许不同内容`);
      }
    } else {
      fs.mkdirSync(path.dirname(versionDir), { recursive: true });
      fs.renameSync(tree, versionDir);
    }
    // 含后端代码：C 方向下扩展后端与宿主同进程，换版只能靠受控重启生效，没有蓝绿或运行期装配。
    const hasBackend = Boolean(preflight.requiresRestart) || Boolean(existing?.requiresRestart);
    const requiresRestart = hasBackend;
    // 观察期：热生效（纯前端 / 蓝绿）从切换完成开始计时（reload 成功后再写），重启生效从下次启动开始。
    const observeUntil: string | null = null;
    commit((draft) => {
      const base: InstallationRecord = {
        ...(draft.extensions[extensionId] ?? {}),
        current: version,
        previous: existing && existing.current !== version ? existing.current : existing?.previous ?? null,
        sourceId,
        packageDigest: digest,
        filesDigest,
        trust,
        permissions: preflight.permissions ?? {},
        state: "observing",
        observeUntil,
        observeAfterRestart: requiresRestart,
        requiresRestart: Boolean(preflight.requiresRestart),
        restartPending: requiresRestart
      };
      draft.extensions[extensionId] = history(base, { revision: draft.revision + 1, action: "install", version, from: existing?.current ?? null, sourceId, actor: (job as Job & { actor?: string }).actor ?? "system" });
    });
    cleanupStaging(job);
    log({ event: "extension-installed", extensionId, version, sourceId, trust, requiresRestart });
    // reload：失败即切回旧版本（或撤销安装）
    board.update(job, { phase: "reload" });
    try {
      const outcome = await reload(extensionId, versionDir, hasBackend);
      if (outcome !== "restart-required") {
        // 切换完成（或热登记完成）：观察期从此刻开始（D10 第 5 步）。
        commit((draft) => {
          const current = draft.extensions[extensionId];
          if (!current || current.current !== version) return;
          draft.extensions[extensionId] = { ...current, observeAfterRestart: false, restartPending: false, observeUntil: new Date(now().getTime() + observeMs).toISOString() };
        });
      }
      return outcome;
    } catch (error) {
      const failure = toManagerError(error, "MARKETPLACE_PREFLIGHT_FAILED");
      if (existing) switchPointer(extensionId, existing.current, "reload-failed-rollback", "system", version);
      else commit((draft) => {
        delete draft.extensions[extensionId];
      });
      throw failure;
    }
  });
}

/** 后台执行任务并按结果落定 job 状态。 */
export function runJob(ctx: ManagerContext, job: Job, work: () => Promise<ExtensionInstallOutcome>): void {
  const { board, log } = ctx;
  void work().then(
    (outcome) => {
      board.succeed(job, outcome);
      log({ event: "extension-job-succeeded", jobId: job.id, action: job.action, outcome, extensionId: job.view.extensionId });
    },
    (error) => {
      ctx.cleanupStaging(job);
      if (job.view.status !== "running") return;
      const failure = toManagerError(error, "MARKETPLACE_PREFLIGHT_FAILED");
      board.fail(job, { code: failure.code, message: failure.message, ...(failure.issues ? { issues: failure.issues } : {}) });
      log({ event: "extension-job-failed", jobId: job.id, action: job.action, code: failure.code, extensionId: job.view.extensionId });
    }
  );
}

export const withActor = (job: Job, actor: string) => Object.assign(job, { actor });

export function failedJob(ctx: ManagerContext, action: Job["action"], sourceId: string, error: ExtensionManagerError, extensionId?: string): ExtensionInstallJobView {
  const { board } = ctx;
  const { job } = board.create({ action, sourceId, ...(extensionId ? { extensionId } : {}) });
  board.fail(job, { code: error.code, message: error.message });
  return job.view;
}

export const unavailableError = () => new ExtensionManagerError("MARKETPLACE_UNAVAILABLE", FAILURE_MESSAGES.MARKETPLACE_UNAVAILABLE!);

export async function installFromFile(ctx: ManagerContext, request: FileInstallRequest): Promise<ExtensionInstallJobView> {
  const { handle, board, cleanupStaging } = ctx;
  if (!handle) return failedJob(ctx, "install", MARKETPLACE_LOCAL_FILE_SOURCE_ID, unavailableError());
  const { job } = board.create({ action: "install", sourceId: MARKETPLACE_LOCAL_FILE_SOURCE_ID });
  withActor(job, request.actor);
  board.update(job, { phase: "download" });
  let file: string;
  try {
    file = await writePackage(ctx, job, request.body);
  } catch (error) {
    cleanupStaging(job);
    const failure = toManagerError(error, "MARKETPLACE_DOWNLOAD_FAILED");
    board.fail(job, { code: failure.code, message: failure.message });
    return job.view;
  }
  runJob(ctx, job, () => finishInstall(ctx, job, file, null));
  return job.view;
}

export function installFromSource(ctx: ManagerContext, request: InstallRequest): ExtensionInstallJobView {
  const { handle, deps, board, toolkit, maxPackageBytes, requireHandle, assertNotAborted } = ctx;
  if (!handle) return failedJob(ctx, "install", request.sourceId, unavailableError());
  const source = deps.marketplace.resolve(request.sourceId);
  if (!source || source.sourceId === MARKETPLACE_LOCAL_FILE_SOURCE_ID) {
    return failedJob(ctx, "install", request.sourceId, new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", `市场来源不存在或不支持按版本安装：${request.sourceId}`), request.extensionId);
  }
  const dedupeKey = `install:${request.sourceId}:${request.extensionId}:${request.range}`;
  const { job, existing } = board.create({ action: "install", sourceId: request.sourceId, dedupeKey, extensionId: request.extensionId });
  if (existing) return job.view;
  withActor(job, request.actor);
  runJob(ctx, job, async () => {
    board.update(job, { phase: "resolve" });
    const availability = source.available();
    if (!availability.ok) throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", availability.reason);
    checkBuiltinConflict(ctx, request.extensionId);
    let ref: ReleaseRef | null;
    try {
      ref = await source.resolve(request.extensionId, request.range, job.controller.signal);
    } catch (error) {
      throw toManagerError(error, "MARKETPLACE_SOURCE_UNAVAILABLE");
    }
    if (!ref) throw new ExtensionManagerError("MARKETPLACE_SOURCE_NOT_FOUND", `来源 ${request.sourceId} 没有满足 ${request.range} 的 ${request.extensionId}（未发布、未审核或已撤回）`);
    if (ref.extensionId !== request.extensionId || ref.sourceId !== request.sourceId) {
      throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "来源返回的版本与请求不一致");
    }
    board.update(job, { version: ref.version });
    const engines = toolkit.checkEnginesCompatible(ref.engines);
    if (!engines.ok) throw new ExtensionManagerError("MARKETPLACE_ENGINES_INCOMPATIBLE", engines.reasons.join("；"), engines.reasons);
    checkDependencies(ctx, ref.dependencies);
    if (ref.size > maxPackageBytes) throw new ExtensionManagerError("MARKETPLACE_PACKAGE_TOO_LARGE", `包大小 ${ref.size} 字节超过上限 ${maxPackageBytes}`);
    // 同一摘要已是当前版本：不下载
    const current = requireHandle().read().extensions[ref.extensionId];
    if (current && current.current === ref.version && current.packageDigest === ref.packageDigest && current.state !== "uninstalling") return "already-current";
    assertNotAborted(job);
    board.update(job, { phase: "download", progress: 0 });
    let download;
    try {
      download = await source.download(ref, job.controller.signal);
    } catch (error) {
      throw toManagerError(error, "MARKETPLACE_DOWNLOAD_FAILED");
    }
    const file = await writePackage(ctx, job, Readable.fromWeb(download.stream as import("node:stream/web").ReadableStream<Uint8Array>), download.size || ref.size);
    return finishInstall(ctx, job, file, ref);
  });
  return job.view;
}
