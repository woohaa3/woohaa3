/**
 * 宿主侧的录制执行器注册表（lease / 能力 / 工作区隔离）
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.4 / design D2）。
 *
 * 职责边界：
 * - 只记录**已注册**执行器，并强制「同一 checkout、同一 peer、未过期 lease」三件事；
 * - 不实现调度、状态机或提交（属任务 5/6）；
 * - 与 WebView 完全无关：WebView 断开不影响注册，只有 peer 断开或 lease 到期才移除。
 *
 * 纯内存、可注入时钟，便于非 GPU 单测。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 执行器能力快照（与 proto `ExecutorCapability` 对应，只保留宿主使用的字段）。 */
export type RecordingExecutorCapability = {
  executorInstanceId: string;
  protocolVersion: string;
  supportedProtocolVersions: string[];
  snapshotSchemaVersion: string;
  rendererVersion: string;
  compilerVersion: string;
  codecVersion: string;
  colorRevision: string;
  gpuAdapter: string;
  gpuBackend: string;
  softwareAdapter: boolean;
  videoDecoders: string[];
  videoEncoders: string[];
  hardwareEncoding: boolean;
  maxResourceChunkBytes: number;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  maxSnapshotBytes: number;
  maxArtifactBytes: number;
  checkoutId: string;
};

/** 注册结果：成功返回 lease，失败给出稳定码。 */
export type RecordingExecutorRegistration =
  | { ok: true; registration: RecordingExecutorRegistrationRecord }
  | { ok: false; code: RecordingExecutorErrorCode; message: string };

export type RecordingExecutorErrorCode =
  | "executor-unauthorized"
  | "executor-checkout-mismatch"
  | "executor-protocol-version-mismatch"
  | "executor-capability-incomplete"
  | "executor-lease-expired"
  | "executor-unknown"
  | "executor-not-local";

export type RecordingExecutorRegistrationRecord = {
  capability: RecordingExecutorCapability;
  /** 注册时确定的 peer 身份（pid + uid）；不同 peer 不能复用同一实例 id。 */
  peerPid: number;
  peerUid: number;
  registeredAt: number;
  leaseExpiresAt: number;
  /** 单调递增：同一实例重注册后旧 epoch 的结果被拒绝。 */
  executionEpoch: number;
};

export type RecordingExecutorRegistryOptions = {
  /** 本宿主实例绑定的 checkout；其它 worktree 的执行器一律拒绝。 */
  checkoutId: string;
  /** 可信启动 nonce；由宿主生成并交给 supervisor，不接受 UI 传入。 */
  registrationNonce?: string;
  now?: () => number;
  /** lease 时长；默认 30 秒，heartbeat 续期。 */
  leaseMs?: number;
  /** 时钟偏移容忍（毫秒），用于判断过期。 */
  clockSkewMs?: number;
  /** 支持的最高协议版本。 */
  protocolVersion: string;
  /** 缺少与宿主一致的协议严格拒绝；测试可放宽以验证协商。 */
  requireExactProtocolVersion?: boolean;
};

const REQUIRED_CAPABILITY_TEXT: Array<keyof RecordingExecutorCapability> = [
  "executorInstanceId",
  "protocolVersion",
  "snapshotSchemaVersion",
  "rendererVersion",
  "compilerVersion",
  "codecVersion",
  "colorRevision"
];

export class RecordingExecutorRegistry {
  private readonly registrations = new Map<string, RecordingExecutorRegistrationRecord>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly clockSkewMs: number;
  private readonly nonce: string | null;
  private epochCounter = 0;

  constructor(private readonly options: RecordingExecutorRegistryOptions) {
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
    this.clockSkewMs = Math.max(0, options.clockSkewMs ?? 1_000);
    this.nonce = options.registrationNonce ?? null;
  }

  /** 生成一次性注册 nonce（宿主启动时调用，经可信启动配置交给 supervisor）。 */
  static createNonce(): string {
    return randomBytes(32).toString("hex");
  }

  /** 常量时间比较 nonce；空 nonce 被视为未启用（仅在宿主显式配置时要求）。 */
  private nonceMatches(candidate: string | undefined): boolean {
    if (this.nonce === null) return true;
    if (!candidate) return false;
    const expected = createHash("sha256").update(this.nonce).digest();
    const actual = createHash("sha256").update(candidate).digest();
    return timingSafeEqual(expected, actual);
  }

  /**
   * 注册一个执行器。
   *
   * 拒绝：nonce 不符、checkout 不同（跨 worktree）、协议不兼容、能力字段缺失。
   * 同一实例重复注册视为重启：递增 `executionEpoch`，旧 epoch 的结果随后被拒绝。
   */
  register(input: {
    capability: RecordingExecutorCapability;
    registrationNonce?: string;
    peerPid: number;
    peerUid: number;
  }): RecordingExecutorRegistration {
    if (!this.nonceMatches(input.registrationNonce)) {
      return { ok: false, code: "executor-unauthorized", message: "执行器注册凭据无效" };
    }
    const capability = input.capability;
    if (capability.checkoutId !== this.options.checkoutId) {
      return {
        ok: false,
        code: "executor-checkout-mismatch",
        message: `执行器属于其它工作区（${capability.checkoutId}），拒绝注册`
      };
    }
    const versions = capability.supportedProtocolVersions ?? [];
    const versionOk = this.options.requireExactProtocolVersion === false
      ? versions.includes(this.options.protocolVersion) || capability.protocolVersion === this.options.protocolVersion
      : versions.length > 0 && versions.every(version => version === this.options.protocolVersion);
    if (!versionOk) {
      return {
        ok: false,
        code: "executor-protocol-version-mismatch",
        message: `执行器协议版本不兼容：需要 ${this.options.protocolVersion}`
      };
    }
    const missing = REQUIRED_CAPABILITY_TEXT.filter(key => {
      const value = capability[key];
      return typeof value !== "string" || value === "";
    });
    if (missing.length) {
      return {
        ok: false,
        code: "executor-capability-incomplete",
        message: `执行器能力缺少字段：${missing.join(", ")}`
      };
    }
    const existing = this.registrations.get(capability.executorInstanceId);
    const executionEpoch = existing ? existing.executionEpoch + 1 : ++this.epochCounter;
    const now = this.now();
    const record: RecordingExecutorRegistrationRecord = {
      capability,
      peerPid: input.peerPid,
      peerUid: input.peerUid,
      registeredAt: now,
      leaseExpiresAt: now + this.leaseMs,
      executionEpoch
    };
    this.registrations.set(capability.executorInstanceId, record);
    return { ok: true, registration: record };
  }

  /**
   * heartbeat 续期；未知、peer 不符或已过期返回 `null`，executor 据此自行退出。
   *
   * `peerPid` 防止另一个同用户进程顶替已有实例 id 续期别人拿到的租约。
   */
  renew(executorInstanceId: string, peerPid: number): RecordingExecutorRegistrationRecord | null {
    const record = this.registrations.get(executorInstanceId);
    if (!record) return null;
    if (record.peerPid !== peerPid) return null;
    if (this.isExpired(record)) {
      this.registrations.delete(executorInstanceId);
      return null;
    }
    record.leaseExpiresAt = this.now() + this.leaseMs;
    return record;
  }

  /** 读取仍然有效（未过期）的注册；过期会被移除并返回 `null`。 */
  get(executorInstanceId: string): RecordingExecutorRegistrationRecord | null {
    const record = this.registrations.get(executorInstanceId);
    if (!record) return null;
    if (this.isExpired(record)) {
      this.registrations.delete(executorInstanceId);
      return null;
    }
    return record;
  }

  /** peer 断开时移除（WebView 断开不会调用本方法）。 */
  disconnect(executorInstanceId: string): void {
    this.registrations.delete(executorInstanceId);
  }

  /** 仍有效的执行器列表；顺带清理过期项。 */
  list(): RecordingExecutorRegistrationRecord[] {
    for (const [id, record] of this.registrations) {
      if (this.isExpired(record)) this.registrations.delete(id);
    }
    return [...this.registrations.values()];
  }

  /**
   * 是否具备真实 GPU 渲染能力。
   *
   * 软件适配器（lavapipe/SwiftShader 等）明确不满足：渲染验收必须真实硬件。
   */
  supportsHardwareRendering(executorInstanceId: string): boolean {
    const record = this.get(executorInstanceId);
    return record !== null && !record.capability.softwareAdapter && record.capability.gpuAdapter !== "";
  }

  private isExpired(record: RecordingExecutorRegistrationRecord): boolean {
    return this.now() > record.leaseExpiresAt + this.clockSkewMs;
  }
}
