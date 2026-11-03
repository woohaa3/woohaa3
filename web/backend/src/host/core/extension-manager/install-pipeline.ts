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
  compareSemver,
  MARKETPLACE_LOCAL_FILE_SOURCE_ID,
  type ExtensionInstallJobView,
  type ExtensionInstallOutcome,
  type ExtensionTrust,
  type MarketplaceFailureCode,
  type MarketplaceSource,
  type ReleaseRef
} from "@woohaa3/contracts";
import { ExtensionManagerError, toManagerError } from "./errors.js";
import type { Job } from "./jobs.js";
import { OFFICIAL_MARKETPLACE_TRUSTED_KEYS } from "./official-trust.js";
import type { ManagerContext } from "./manager-context.js";
import { FAILURE_MESSAGES, type FileInstallRequest, type InstallRequest } from "./manager-types.js";
import type { InstallationRecord } from "./types.js";

/** 成功读到多少 / 目标大小 → 界面可读的进度文案；来源没声明大小时退到字节数。 */
function receivedText(received: number, expectedSize: number | undefined): string {
  if (expectedSize && expectedSize > 0) return `已收到 ${Math.min(100, Math.floor((received / expectedSize) * 100))}%`;
  return `已收到 ${received} 字节`;
}

/** 本地磁盘问题不是网络问题：直接说明，且不重试。 */
const LOCAL_WRITE_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EISDIR"]);

/** 流式写包，限制大小，支持取消。 */
export async function writePackage(ctx: ManagerContext, job: Job, body: Readable | AsyncIterable<Uint8Array>, expectedSize?: number): Promise<string> {
  const { board, maxPackageBytes, downloadIdleTimeoutMs } = ctx;
  const dir = ctx.stagingFor(job);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "package.wxt");
  if (expectedSize !== undefined && expectedSize > maxPackageBytes) {
    throw new ExtensionManagerError("MARKETPLACE_PACKAGE_TOO_LARGE", `包大小 ${expectedSize} 字节超过上限 ${maxPackageBytes}`);
  }
  let received = 0;
  // 来源自己不一定给传输设时限（本部署市场只透传会话 signal）。这里做一层与来源无关的看门狗：
  // 连续 downloadIdleTimeoutMs 没有新字节就销毁这条流水线，交给重试，别让任务无限挂住。
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      counter.destroy(new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "下载停滞：" + Math.round(downloadIdleTimeoutMs / 1000) + " 秒内没有收到新数据", undefined, { retryable: true }));
    }, downloadIdleTimeoutMs);
  };
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxPackageBytes) {
        callback(new ExtensionManagerError("MARKETPLACE_PACKAGE_TOO_LARGE", `包超过上限 ${maxPackageBytes} 字节`));
        return;
      }
      if (expectedSize) board.update(job, { progress: Math.min(1, received / expectedSize) });
      armIdle();
      callback(null, chunk);
    }
  });
  const source = body instanceof Readable ? body : Readable.from(body);
  armIdle();
  try {
    await pipeline(source, counter, fs.createWriteStream(file, { flags: "wx", mode: 0o644 }), { signal: job.controller.signal });
  } catch (error) {
    if (job.controller.signal.aborted) throw new ExtensionManagerError("MARKETPLACE_CANCELLED", "安装已取消");
    const localCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (localCode && LOCAL_WRITE_CODES.has(localCode)) {
      throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", `无法写入安装包（${localCode}）`);
    }
    const failure = toManagerError(error, "MARKETPLACE_DOWNLOAD_FAILED", { retryable: true });
    // 大小上限之类保留原码与原意；只有传输中断才补「读到哪里」，否则界面上只剩一句「读取安装包失败」。
    if (failure.code !== "MARKETPLACE_DOWNLOAD_FAILED") throw failure;
    throw new ExtensionManagerError(
      "MARKETPLACE_DOWNLOAD_FAILED",
      `${failure.message}（${receivedText(received, expectedSize)}）`,
      undefined,
      { retryable: true }
    );
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }
  if (received === 0) throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "包为空（没有读到任何字节）", undefined, { retryable: true });
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

/**
 * 内置扩展的同 id 安装只允许**严格升级**（semantic version）：
 * - 没有内置版本：正常安装；
 * - 待安装版本 <= 内置版本：拒绝，内置版本继续生效；
 * - 待安装版本 > 内置版本：允许，受管版本在重启/热切换后覆盖内置版本；
 * - 站点后端（backend 工厂）暂不支持运行期覆盖，直接给出可解释的拒绝。
 */
/** 从 `signed:<keyId>` 取发布者 keyId；未签名返回 null。 */
export function publisherKeyIdOf(trust: ExtensionTrust | undefined): string | null {
  return trust?.startsWith("signed:") ? trust.slice("signed:".length) : null;
}

const OFFICIAL_PUBLISHER_KEY_IDS = new Set(
  OFFICIAL_MARKETPLACE_TRUSTED_KEYS.map((key) => key.keyId).filter((keyId): keyId is string => typeof keyId === "string" && keyId.length > 0)
);

/**
 * 发布者绑定：信任 = 签名 key，不等于「这个 key 可以代表任意 extensionId」。
 *
 * - 内置官方扩展只接受官方发布者 key 的覆盖；其它本机信任的 key 不能用同名包顶替。
 * - 已安装的受管扩展默认绑定第一次安装时的签名 key（TOFU）：后续更新的 key 变了就拒绝，
 *   需要先卸载再安装，避免一个已信任的 key 悄悄接管另一个扩展的 id。
 *
 * 这不能防「官方根私钥本身被攻陷」——那种情况下需要每扩展独立密钥 / 证书链，见设计文档。
 */
export function assertPublisherBinding(input: {
  extensionId: string;
  builtin: boolean;
  existingTrust: ExtensionTrust | undefined;
  incomingTrust: ExtensionTrust;
  officialKeyIds?: ReadonlySet<string>;
}): void {
  const incoming = publisherKeyIdOf(input.incomingTrust);
  const official = input.officialKeyIds ?? OFFICIAL_PUBLISHER_KEY_IDS;
  if (input.builtin) {
    if (!incoming || !official.has(incoming)) {
      throw new ExtensionManagerError(
        "MARKETPLACE_PUBLISHER_CHANGED",
        `内置扩展 ${input.extensionId} 只接受官方发布者签名；当前包${incoming ? `由 ${incoming} 签名` : "未签名"}`
      );
    }
    return;
  }
  const previous = publisherKeyIdOf(input.existingTrust);
  if (previous && previous !== incoming) {
    throw new ExtensionManagerError(
      "MARKETPLACE_PUBLISHER_CHANGED",
      `扩展 ${input.extensionId} 的发布者签名已变更（${previous} → ${incoming ?? "未签名"}）；拒绝更新，请先卸载再安装`
    );
  }
}

export function checkBuiltinUpgrade(ctx: ManagerContext, extensionId: string, version: string): void {
  const builtin = ctx.deps.builtins?.().get(extensionId);
  if (!builtin) return;
  if (!builtin.version) {
    throw new ExtensionManagerError("MARKETPLACE_BUILTIN_CONFLICT", `扩展 ${extensionId} 已是内置扩展，但内置版本未知，不能安全比较；先升级客户端`);
  }
  if (compareSemver(version, builtin.version) <= 0) {
    throw new ExtensionManagerError(
      "MARKETPLACE_BUILTIN_CONFLICT",
      `内置版本 ${builtin.version} 不低于待安装的 ${version}；同 id 只允许安装更高的版本`
    );
  }
  if (builtin.requiresBackend && !builtin.hotSwappable) {
    throw new ExtensionManagerError(
      "MARKETPLACE_BUILTIN_CONFLICT",
      `${extensionId} 是站点后端扩展，暂不支持从市场覆盖升级；请等待客户端版本更新`
    );
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
  const acceptUntrusted = job.acceptUntrusted === true;
  const verifyTree = (treeDir: string) =>
    toolkit.verifyExtensionPackage({
      treeDir,
      packageDigest: digest,
      trustedKeys: trustConfig.trustedKeys,
      allowUnsigned: acceptUntrusted,
      acceptUntrusted
    });
  let trust: ExtensionTrust;
  let evidence: Record<string, unknown> | undefined;
  try {
    ({ trust, evidence } = await verifyTree(tree));
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
  checkBuiltinUpgrade(ctx, extensionId, version);
  checkDependencies(ctx, preflight.dependencies);
  const filesDigest = await toolkit.filesDigest(tree);
  assertNotAborted(job);

  // commit：唯一提交点之前不可取消
  board.update(job, { phase: "commit" });
  return board.serial(async () => {
    job.committing = true;
    const state = h.read();
    const existing = state.extensions[extensionId];
    if (existing?.trust?.startsWith("certified:") && !trust.startsWith("certified:")) throw new ExtensionManagerError("MARKETPLACE_SIGNATURE_INVALID", "证书扩展不能降级为裸公钥信任");
    if (existing && existing.current === version && existing.filesDigest === filesDigest && existing.state !== "uninstalling" && !existing.quarantine && existing.trust === trust) {
      await verifyTree(h.layout.versionDir(extensionId, version));
      cleanupStaging(job);
      return "already-current" as const;
    }
    if (!trust.startsWith("certified:")) assertPublisherBinding({
      extensionId,
      builtin: Boolean(ctx.deps.builtins?.().get(extensionId)),
      existingTrust: existing?.trust,
      incomingTrust: trust,
      ...(ctx.deps.officialPublisherKeyIds ? { officialKeyIds: ctx.deps.officialPublisherKeyIds() } : {})
    });
    const versionDir = h.layout.versionDir(extensionId, version);
    if (fs.existsSync(versionDir)) {
      // 同版本目录已存在（孤儿或旧 previous）：内容一致则复用，不一致拒绝覆盖。
      const present = await toolkit.filesDigest(versionDir);
      if (present !== filesDigest) {
        throw new ExtensionManagerError("MARKETPLACE_VERSION_CONTENT_CONFLICT", `${extensionId}@${version} 已存在且内容不同；同版本号不允许不同内容`);
      }
      // Reusing a directory must verify its actual bytes, not only its FILES manifest.
      await verifyTree(versionDir);
    } else {
      fs.mkdirSync(path.dirname(versionDir), { recursive: true });
      fs.renameSync(tree, versionDir);
    }
    // 含后端代码：只有 hostPlugin 能运行期换版（扩展层 add/swap + 各版本独立模块 URL）。
    // 站点 backend 工厂没有运行期装配入口，即使宿主支持换版也按受控重启处理。
    const hasBackend = Boolean(preflight.requiresRestart) || Boolean(existing?.requiresRestart);
    const hotSwappable = preflight.hotSwappable !== false;
    const requiresRestart = hasBackend && (!ctx.deps.runtime?.available() || !hotSwappable);
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
        evidence,
        quarantine: undefined,
        quarantineCleanupPending: undefined,
        versions: {
          ...(existing?.versions ?? {}),
          ...(existing ? {[existing.current]: {filesDigest:existing.filesDigest,packageDigest:existing.packageDigest,trust:existing.trust,evidence:existing.evidence}} : {}),
          [version]: {filesDigest,packageDigest:digest,trust,evidence}
        },
        state: "observing",
        observeUntil,
        observeAfterRestart: requiresRestart,
        requiresRestart: Boolean(preflight.requiresRestart),
        hotSwappable,
        restartPending: requiresRestart
      };
      draft.extensions[extensionId] = history(base, { revision: draft.revision + 1, action: "install", version, from: existing?.current ?? null, sourceId, actor: (job as Job & { actor?: string }).actor ?? "system" });
    });
    cleanupStaging(job);
    log({ event: "extension-installed", extensionId, version, sourceId, trust, requiresRestart });
    // 同 id 覆盖内置版本时，失败要装回内置目录（第一个受管版本没有 previous 记录）。
    const builtin = ctx.deps.builtins?.().get(extensionId);
    const previousDirectory = existing
      ? h.layout.versionDir(extensionId, existing.current)
      : builtin?.directory ?? null;
    // 内置版本有后端、而市场版本是纯前端：先把旧的内置运行期实例撤下，再发布浏览器产物。
    if (!existing && builtin?.requiresBackend && !hasBackend && ctx.deps.runtime?.available()) {
      try {
        await ctx.deps.runtime.remove(extensionId);
      } catch (error) {
        log({ event: "extension-runtime-remove-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    // reload：失败即切回旧版本（或撤销安装）
    board.update(job, { phase: "reload" });
    try {
      const outcome = await reload(extensionId, versionDir, hasBackend, { previousDirectory, hotSwappable });
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
      if (existing?.quarantine) {
        // 已隔离的扩展重装失败：指针与版本证据回退到隔离前的状态，只额外标记“清理要再做一遍”，
        // 避免记录停在“已提交新版本、实际没起来”的半新状态。
        commit(draft => { draft.extensions[extensionId] = {...existing, quarantineCleanupPending:true}; });
      } else if (existing) switchPointer(extensionId, existing.current, "reload-failed-rollback", "system", version);
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
  job.acceptUntrusted = request.acceptUntrusted === true;
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

/**
 * 下载并落盘；瞬时失败（断流 / 网络超时 / 5xx）自动重试。
 *
 * 每次重试前清空 staging：`writePackage` 用 `wx` 写包，上一次的半截包残留会让下一次直接 EEXIST；
 * 进度同时回到 0，避免界面沿用上一轮的百分比误导「已经下到一半」。
 */
async function downloadWithRetry(ctx: ManagerContext, job: Job, source: MarketplaceSource, ref: ReleaseRef): Promise<string> {
  const { board, log, cleanupStaging, assertNotAborted, sleep, downloadAttempts, downloadBackoffMs } = ctx;
  let last: ExtensionManagerError | null = null;
  for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
    assertNotAborted(job);
    if (attempt > 1) {
      cleanupStaging(job);
      const backoff = downloadBackoffMs[Math.min(attempt - 2, downloadBackoffMs.length - 1)] ?? 0;
      if (backoff > 0) await sleep(backoff, job.controller.signal);
      assertNotAborted(job);
      log({ event: "extension-download-retry", jobId: job.id, extensionId: ref.extensionId, version: ref.version, attempt, code: last?.code });
    }
    board.update(job, { phase: "download", progress: 0 });
    try {
      const download = await source.download(ref, job.controller.signal);
      return await writePackage(ctx, job, Readable.fromWeb(download.stream as import("node:stream/web").ReadableStream<Uint8Array>), download.size || ref.size);
    } catch (error) {
      const failure = toManagerError(error, "MARKETPLACE_DOWNLOAD_FAILED", { retryable: true });
      last = failure;
      if (job.controller.signal.aborted || !failure.retryable || attempt >= downloadAttempts) {
        throw attempt > 1 ? noteAttempts(failure, attempt) : failure;
      }
    }
  }
  throw last ?? new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "读取安装包失败");
}

/** 重试过之后把「试了几次」写进原因：用户据此区分「网络抖动」与「包本身有问题」。 */
function noteAttempts(failure: ExtensionManagerError, attempts: number): ExtensionManagerError {
  return new ExtensionManagerError(failure.code, `${failure.message}（已尝试 ${attempts} 次）`, failure.issues, { retryable: false });
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
  job.acceptUntrusted = request.acceptUntrusted === true;
  runJob(ctx, job, async () => {
    board.update(job, { phase: "resolve" });
    const availability = source.available();
    if (!availability.ok) throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", availability.reason);
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
    checkBuiltinUpgrade(ctx, ref.extensionId, ref.version);
    const engines = toolkit.checkEnginesCompatible(ref.engines);
    if (!engines.ok) throw new ExtensionManagerError("MARKETPLACE_ENGINES_INCOMPATIBLE", engines.reasons.join("；"), engines.reasons);
    checkDependencies(ctx, ref.dependencies);
    if (ref.size > maxPackageBytes) throw new ExtensionManagerError("MARKETPLACE_PACKAGE_TOO_LARGE", `包大小 ${ref.size} 字节超过上限 ${maxPackageBytes}`);
    // 同一摘要已是当前版本：不下载
    const current = requireHandle().read().extensions[ref.extensionId];
    if (current && current.current === ref.version && current.packageDigest === ref.packageDigest && current.state !== "uninstalling" && !current.quarantine) {
      await toolkit.verifyManagedActivation?.({dir:requireHandle().layout.versionDir(ref.extensionId,ref.version),record:current});
      return "already-current";
    }
    assertNotAborted(job);
    const file = await downloadWithRetry(ctx, job, source, ref);
    return finishInstall(ctx, job, file, ref);
  });
  return job.view;
}
